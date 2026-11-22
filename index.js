import { MongoClient, ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import Stripe from "stripe";

// Environment Variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.join(__dirname, ".env"),
});

const app = express();
const PORT = process.env.PORT || 5000;

// Stripe
if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is missing from .env");
}

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is missing from .env");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// JWT Configuration
const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL;

if (!BETTER_AUTH_URL) {
  throw new Error("BETTER_AUTH_URL is missing from .env");
}

const JWKS = createRemoteJWKSet(
  new URL("/api/auth/jwks", BETTER_AUTH_URL)
);

// MongoDB Collections
let menuCollection;
let usersCollection;
let ordersCollection;
let notificationsCollection;
let transactionsCollection;

// JWT Verification Middleware
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).send({
        message: "Unauthorized access",
      });
    }

    const token = authHeader.split(" ")[1];

    const { payload } = await jwtVerify(token, JWKS);

    if (!payload.email) {
      return res.status(401).send({
        message: "Invalid token user",
      });
    }

    const user = await usersCollection.findOne({
      email: payload.email,
    });

    if (!user) {
      return res.status(401).send({
        message: "User not found",
      });
    }

    req.user = {
      id: user._id,
      email: user.email,
      role: user.role,
    };

    next();
  } catch (error) {
    console.error("JWT Verification Error:", error.message);

    return res.status(401).send({
      message: "Invalid or expired token",
    });
  }
};

// Role Verification Middleware
const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).send({
        message: "Forbidden: You don't have permission",
      });
    }

    next();
  };
};

// CORS
app.use(cors());

// Premium Price ID
const PREMIUM_PRICE_ID = "price_1UeBWfA3jFSCMLqEUNSiv0Xq";

// Premium Payment Verification
async function finalizePremiumPayment(session) {
  if (
    session.payment_status !== "paid" ||
    session.mode !== "payment"
  ) {
    return {
      ok: false,
      httpStatus: 400,
      message: "Payment not completed",
    };
  }

  const vendorEmail = session.metadata?.vendorEmail;

  if (
    !vendorEmail ||
    session.metadata?.plan !== "premium" ||
    session.amount_total !== 1999 ||
    session.currency !== "usd"
  ) {
    return {
      ok: false,
      httpStatus: 400,
      message: "Invalid Premium payment information",
    };
  }

  const lineItems = await stripe.checkout.sessions.listLineItems(
    session.id
  );

  const isCorrectPrice = lineItems.data.some(
    (item) => item.price?.id === PREMIUM_PRICE_ID
  );

  if (!isCorrectPrice) {
    return {
      ok: false,
      httpStatus: 400,
      message: "Incorrect Premium Price ID",
    };
  }

  const vendor = await usersCollection.findOne({
    email: vendorEmail,
    role: "vendor",
  });

  if (!vendor) {
    return {
      ok: false,
      httpStatus: 404,
      message: "Vendor not found",
    };
  }

  await transactionsCollection.updateOne(
    { sessionId: session.id },
    {
      $setOnInsert: {
        sessionId: session.id,
        vendorEmail,
        amount: session.amount_total / 100,
        currency: session.currency,
        paymentStatus: "paid",
        plan: "premium",
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );

  await usersCollection.updateOne(
    {
      email: vendorEmail,
      role: "vendor",
    },
    {
      $set: {
        subscriptionPlan: "premium",
        subscriptionPurchasedAt: new Date(),
      },
    }
  );

  console.log("Premium activated:", vendorEmail);

  return {
    ok: true,
    vendorEmail,
  };
}

// Stripe Webhook
app.post(
  "/payments/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error("Webhook Error:", error.message);

      return res.status(400).send(
        `Webhook Error: ${error.message}`
      );
    }

    try {
      if (
        event.type === "checkout.session.completed" ||
        event.type === "checkout.session.async_payment_succeeded"
      ) {
        if (!usersCollection || !transactionsCollection) {
          return res.status(503).send({
            message: "Database not ready",
          });
        }

        const result = await finalizePremiumPayment(
          event.data.object
        );

        if (!result.ok) {
          return res.status(result.httpStatus).send({
            message: result.message,
          });
        }
      }

      res.status(200).send({
        received: true,
      });
    } catch (error) {
      console.error("Webhook Processing Error:", error);

      res.status(500).send({
        message: "Webhook processing failed",
      });
    }
  }
);

// Verify Premium Payment
app.get(
  "/payments/verify",
  verifyToken,
  requireRole("vendor"),
  async (req, res) => {
    try {
      const { session_id } = req.query;

      if (!session_id) {
        return res.status(400).send({
          success: false,
          message: "Session ID is required",
        });
      }

      const session = await stripe.checkout.sessions.retrieve(
        session_id
      );

      if (
        session.metadata?.vendorEmail !== req.user.email
      ) {
        return res.status(403).send({
          success: false,
          message: "Unauthorized payment verification",
        });
      }

      const result = await finalizePremiumPayment(session);

      if (!result.ok) {
        return res.status(result.httpStatus).send({
          success: false,
          message: result.message,
        });
      }

      res.send({
        success: true,
        verified: true,
        vendorEmail: result.vendorEmail,
        message: "Payment verified successfully",
      });
    } catch (error) {
      console.error("Payment Verification Error:", error);

      res.status(500).send({
        success: false,
        message: "Payment verification failed",
      });
    }
  }
);

// JSON Middleware
app.use(express.json());

// MongoDB Connection
const client = new MongoClient(
  process.env.MONGODB_URI
);

export async function connectToMongoDB() {
  try {
    await client.connect();

    const db = client.db("PizzaHub");

    menuCollection = db.collection("menuItems");
    usersCollection = db.collection("user");
    ordersCollection = db.collection("orders");
    transactionsCollection = db.collection("transactions");
    notificationsCollection = db.collection("notifications");

    console.log("MongoDB Connected Successfully!");
    console.log("Database: PizzaHub");

    return {
      client,
      db,
      menuCollection,
      usersCollection,
      ordersCollection,
      transactionsCollection,
    };
  } catch (error) {
    console.error("MongoDB Connection Failed:", error);
    throw error;
  }
}

// Test Route
app.get("/", (req, res) => {
  res.send("PizzaHub Server is Running!");
});

// ======================================
// MENU APIs
// ======================================

// Get All Menu Items
app.get("/menu", async (req, res) => {
  try {
    const result = await menuCollection.find().toArray();

    res.send(result);
  } catch (error) {
    console.error(error);

    res.status(500).send({
      message: "Failed to fetch menu items",
    });
  }
});

// Add Menu Item
app.post(
  "/menu",
  verifyToken,
  requireRole("vendor"),
  async (req, res) => {
    try {
      const newItem = {
        ...req.body,
        vendorEmail: req.user.email,
        createdAt: new Date(),
      };

      if (
        !newItem.name ||
        newItem.price === undefined ||
        !newItem.category
      ) {
        return res.status(400).send({
          message: "Name, price and category are required",
        });
      }

      newItem.price = Number(newItem.price);

      if (
        !Number.isFinite(newItem.price) ||
        newItem.price <= 0
      ) {
        return res.status(400).send({
          message: "Invalid price",
        });
      }

      delete newItem._id;
      delete newItem.status;
      delete newItem.available;

      newItem.status = "pending";
      newItem.available = false;

      const result = await menuCollection.insertOne(newItem);



// Create notification for admins
try {
  const vendor = await usersCollection.findOne({
    email: req.user.email,
  });

  const admins = await usersCollection
    .find(
      { role: "admin" },
      {
        projection: {
          email: 1,
          notificationPreferences: 1,
        },
      }
    )
    .toArray();

  const adminNotifications = admins
    .filter(
      (admin) =>
        admin.notificationPreferences?.menuApprovals !== false
    )
    .map((admin) => ({
      recipientEmail: admin.email,
      title: "New Menu Approval Request",
      message: `${vendor?.name || req.user.email} submitted "${newItem.name}" for approval.`,
      type: "menu_approval",
      relatedId: result.insertedId,
      isRead: false,
      createdAt: new Date(),
    }));

  if (adminNotifications.length > 0) {
    await notificationsCollection.insertMany(adminNotifications);
  }
} catch (notificationError) {
  console.error(
    "Failed to create menu notification:",
    notificationError
  );
}


      res.status(201).send(result);
    } catch (error) {
      console.error(error);

      res.status(500).send({
        message: "Failed to add menu item",
      });
    }
  }
);

// Update Menu Item
app.patch(
  "/menu/:id",
  verifyToken,
  requireRole("vendor", "admin"),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          message: "Invalid menu item ID",
        });
      }

      const item = await menuCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!item) {
        return res.status(404).send({
          message: "Menu item not found",
        });
      }

      if (
        req.user.role !== "admin" &&
        item.vendorEmail !== req.user.email
      ) {
        return res.status(403).send({
          message: "Access denied",
        });
      }

      const allowedFields = [
        "name",
        "description",
        "price",
        "category",
        "image",
      ];

      const updatedItem = {};

      for (const key of allowedFields) {
        if (req.body[key] !== undefined) {
          updatedItem[key] = req.body[key];
        }
      }

      if (updatedItem.price !== undefined) {
        updatedItem.price = Number(updatedItem.price);

        if (
          !Number.isFinite(updatedItem.price) ||
          updatedItem.price <= 0
        ) {
          return res.status(400).send({
            message: "Invalid price",
          });
        }
      }

      if (Object.keys(updatedItem).length === 0) {
        return res.status(400).send({
          message: "No valid fields provided",
        });
      }

      updatedItem.updatedAt = new Date();

      await menuCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updatedItem }
      );

      res.send({
        success: true,
        message: "Menu item updated successfully",
      });
    } catch (error) {
      console.error(error);

      res.status(500).send({
        message: "Failed to update menu item",
      });
    }
  }
);

// Delete Menu Item
app.delete(
  "/menu/:id",
  verifyToken,
  requireRole("vendor", "admin"),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          message: "Invalid menu item ID",
        });
      }

      const item = await menuCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!item) {
        return res.status(404).send({
          message: "Menu item not found",
        });
      }

      if (
        req.user.role !== "admin" &&
        item.vendorEmail !== req.user.email
      ) {
        return res.status(403).send({
          message: "Access denied",
        });
      }

      await menuCollection.deleteOne({
        _id: new ObjectId(id),
      });

      res.send({
        success: true,
        message: "Menu item deleted successfully",
      });
    } catch (error) {
      console.error(error);

      res.status(500).send({
        message: "Failed to delete menu item",
      });
    }
  }
);

// Update Menu Availability
app.patch(
  "/menu/:id/availability",
  verifyToken,
  requireRole("vendor"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { available } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          message: "Invalid menu item ID",
        });
      }

      if (typeof available !== "boolean") {
        return res.status(400).send({
          message: "Availability must be true or false",
        });
      }

      const item = await menuCollection.findOne({
        _id: new ObjectId(id),
        vendorEmail: req.user.email,
      });

      if (!item) {
        return res.status(404).send({
          message: "Menu item not found",
        });
      }

      if (item.status !== "approved") {
        return res.status(403).send({
          message: "Only approved items can be activated",
        });
      }

      if (available) {
        const vendor = await usersCollection.findOne({
          email: req.user.email,
        });

        if (vendor.subscriptionPlan !== "premium") {
          const activeItems = await menuCollection.countDocuments({
            vendorEmail: req.user.email,
            status: "approved",
            available: true,
            _id: { $ne: new ObjectId(id) },
          });

          if (activeItems >= 3) {
            return res.status(403).send({
              message:
                "Free vendors can have only 3 active menu items. Upgrade to Premium.",
            });
          }
        }
      }

      await menuCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { available } }
      );

      res.send({
        success: true,
        message: "Menu availability updated successfully",
      });
    } catch (error) {
      console.error(error);

      res.status(500).send({
        message: "Failed to update availability",
      });
    }
  }
);

// ======================================
// CUSTOMER FAVORITES
// ======================================

// Get Customer Favorites
app.get(
  "/customer/favorites/:email",
  verifyToken,
  requireRole("customer"),
  async (req, res) => {
    try {
      if (req.params.email !== req.user.email) {
        return res.status(403).send({
          message: "Access denied",
        });
      }

      const customer = await usersCollection.findOne({
        email: req.user.email,
        role: "customer",
      });

      if (!customer) {
        return res.status(404).send({
          message: "Customer not found",
        });
      }

      const favoriteIds = (customer.favoriteItems || [])
        .filter((id) => ObjectId.isValid(id))
        .map((id) => new ObjectId(id));

      const favorites = await menuCollection
        .find({
          _id: { $in: favoriteIds },
          status: "approved",
          available: true,
        })
        .toArray();

      res.send(favorites);
    } catch (error) {
      console.error(error);

      res.status(500).send({
        message: "Failed to fetch favorites",
      });
    }
  }
);

// Add Customer Favorite
app.post(
  "/customer/favorites/:email/:itemId",
  verifyToken,
  requireRole("customer"),
  async (req, res) => {
    try {
      const { email, itemId } = req.params;

      if (email !== req.user.email) {
        return res.status(403).send({
          message: "Access denied",
        });
      }

      if (!ObjectId.isValid(itemId)) {
        return res.status(400).send({
          message: "Invalid menu item ID",
        });
      }

      const item = await menuCollection.findOne({
        _id: new ObjectId(itemId),
        status: "approved",
        available: true,
      });

      if (!item) {
        return res.status(404).send({
          message: "Menu item not found",
        });
      }

      await usersCollection.updateOne(
        {
          email: req.user.email,
          role: "customer",
        },
        {
          $addToSet: {
            favoriteItems: new ObjectId(itemId),
          },
        }
      );

      res.send({
        success: true,
        message: "Added to favorites",
      });
    } catch (error) {
      console.error(error);

      res.status(500).send({
        message: "Failed to add favorite",
      });
    }
  }
);


// Remove Customer Favorite
app.delete(
  "/customer/favorites/:email/:itemId",
  verifyToken,
  requireRole("customer"),
  async (req, res) => {
    try {
      const { email, itemId } = req.params;

      if (email !== req.user.email) {
        return res.status(403).send({ message: "Access denied" });
      }

      if (!ObjectId.isValid(itemId)) {
        return res.status(400).send({ message: "Invalid menu item ID" });
      }

      const result = await usersCollection.updateOne(
        { email: req.user.email, role: "customer" },
        { $pull: { favoriteItems: { $in: [new ObjectId(itemId), itemId] } } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({ message: "Customer not found" });
      }

      res.send({ success: true, message: "Removed from favorites" });
    } catch (error) {
      console.error("Failed to remove favorite:", error);
      res.status(500).send({ message: "Failed to remove favorite" });
    }
  }
);

//admin releted API

// Admin approve or reject menu item
app.patch("/admin/menu/:id/status", verifyToken , requireRole("admin"), async (req, res) => {
  try {
    const id = req.params.id;
    const { status } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid menu item ID",
      });
    }

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).send({
        message: "Status must be approved or rejected",
      });
    }

    const item = await menuCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!item) {
      return res.status(404).send({
        message: "Menu item not found",
      });
    }

    if (item.status !== "pending") {
      return res.status(400).send({
        message: "Only pending items can be reviewed",
      });
    }

    
let available = false;
let limitReached = false;

if (status === "approved") {
  const vendor = await usersCollection.findOne({
    email: item.vendorEmail,
    role: "vendor",
  });

  if (!vendor) {
    return res.status(404).send({
      message: "Vendor not found",
    });
  }

  const isPremium = vendor.subscriptionPlan === "premium";

  const activeItems = await menuCollection.countDocuments({
    vendorEmail: item.vendorEmail,
    status: "approved",
    available: true,
  });

  if (isPremium) {
    available = true;
  } else if (activeItems < 3) {
    available = true;
  } else {
    limitReached = true;
  }
}


    await menuCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status,
          available,
        },
      },
    );

    res.status(200).send({
      message: limitReached
        ? "Menu approved, but vendor reached the Free Plan limit. This item remains inactive."
        : `Menu item ${status} successfully`,
      available,
      limitReached,
    });
  } catch (error) {
    console.error("Failed to review menu item:", error);

    res.status(500).send({
      message: "Failed to update menu item status",
    });
  }
});

// Admin Notification Preferences API

// Get All Users for Admin
app.get("/admin/users", verifyToken, requireRole("admin"), async (req, res) => {
  try {
    const users = await usersCollection
      .find(
        {},
        {
          projection: {
            name: 1,
            email: 1,
            role: 1,
            image: 1,
            profileImage: 1,
            restaurantName: 1,
            phone: 1,
            createdAt: 1,
            subscriptionPlan: 1,
            subscriptionExpiresAt: 1,
            subscriptionPurchasedAt: 1,
          },
        },
      )
      .sort({ createdAt: -1 })
      .toArray();

    const orderCounts = await ordersCollection
      .aggregate([
        {
          $group: {
            _id: "$customerEmail",
            totalOrders: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const usersWithOrders = users.map((user) => {
      const orderInfo = orderCounts.find((order) => order._id === user.email);

      return {
        ...user,
        orders: orderInfo?.totalOrders || 0,
      };
    });

    res.send(usersWithOrders);
  } catch (error) {
    console.error("Failed to fetch admin users:", error);

    res.status(500).send({
      message: "Failed to fetch users",
    });
  }
});

// Get All Vendors for Admin
app.get("/admin/vendors",verifyToken,requireRole("admin"),async (req, res) => {
    try {
      const vendors = await usersCollection
        .find(
          { role: "vendor" },
          {
            projection: {
              name: 1,
              email: 1,
              image: 1,
              profileImage: 1,
              restaurantLogo: 1,
              restaurantName: 1,
              phone: 1,
              createdAt: 1,
              subscriptionPlan: 1,
              subscriptionExpiresAt: 1,
              subscriptionPurchasedAt: 1,
            },
          },
        )
        .sort({ createdAt: -1 })
        .toArray();

      const menuCounts = await menuCollection
        .aggregate([
          {
            $group: {
              _id: "$vendorEmail",
              totalMenuItems: { $sum: 1 },
            },
          },
        ])
        .toArray();

      const orderCounts = await ordersCollection
        .aggregate([
          {
            $group: {
              _id: "$vendorEmail",
              totalOrders: { $sum: 1 },
            },
          },
        ])
        .toArray();

      const vendorsWithStats = vendors.map((vendor) => {
        const menuInfo = menuCounts.find((item) => item._id === vendor.email);

        const orderInfo = orderCounts.find((item) => item._id === vendor.email);

        return {
          ...vendor,
          menuItems: menuInfo?.totalMenuItems || 0,
          orders: orderInfo?.totalOrders || 0,
        };
      });

      res.send(vendorsWithStats);
    } catch (error) {
      console.error("Failed to fetch admin vendors:", error);

      res.status(500).send({
        message: "Failed to fetch vendors",
      });
    }
  },
);

// Get Admin Notification Preferences
app.get("/admin/preferences/:email", verifyToken, requireRole("admin"), async (req, res) => {
  try {
    const { email } = req.params;

    if (email !== req.user.email) {
      return res.status(403).send({ message: "Access denied" });
    }

    const admin = await usersCollection.findOne(
      { email: req.user.email, role: "admin" },
      {
        projection: {
          notificationPreferences: 1,
        },
      },
    );

    if (!admin) {
      return res.status(404).send({
        message: "Admin not found",
      });
    }

    const preferences = {
      newOrders: true,
      vendorApplications: true,
      menuApprovals: true,
      transactions: false,
      ...admin.notificationPreferences,
    };

    res.send(preferences);
  } catch (error) {
    console.error("Failed to fetch notification preferences:", error);

    res.status(500).send({
      message: "Failed to fetch notification preferences",
    });
  }
});

// Update Admin Notification Preferences
app.patch("/admin/preferences/:email", verifyToken,requireRole("admin"), async (req, res) => {
  try {
    const { email } = req.params;

    if (email !== req.user.email) {
      return res.status(403).send({ message: "Access denied" });
    }

    const updates = {};

    const allowedPreferences = [
      "newOrders",
      "vendorApplications",
      "menuApprovals",
      "transactions",
    ];

    for (const key of allowedPreferences) {
      if (typeof req.body[key] === "boolean") {
        updates[`notificationPreferences.${key}`] = req.body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).send({
        message: "No valid notification preferences provided",
      });
    }

    const result = await usersCollection.updateOne(
      { email: req.user.email, role: "admin" },
      {
        $set: {
          ...updates,
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        message: "Admin not found",
      });
    }

    res.send({
      success: true,
      message: "Notification preferences updated successfully",
    });
  } catch (error) {
    console.error("Failed to update notification preferences:", error);

    res.status(500).send({
      message: "Failed to update notification preferences",
    });
  }
});

// Get All Transactions (Admin)
app.get("/admin/transactions", verifyToken , requireRole("admin"), async (req, res) => {
  try {
    const transactions = await transactionsCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    const formattedTransactions = await Promise.all(
      transactions.map(async (transaction) => {
        const vendor = await usersCollection.findOne(
          { email: transaction.vendorEmail },
          { projection: { name: 1 } },
        );

        return {
          ...transaction,
          vendorName: vendor?.name || "Unknown Vendor",
        };
      }),
    );

    res.status(200).send(formattedTransactions);
  } catch (error) {
    console.error("Failed to fetch transactions:", error);
    res.status(500).send({
      message: "Failed to fetch transactions",
    });
  }
});

//customer er API

// Customer Place Order API
app.post("/orders", verifyToken, requireRole("customer"), async (req, res) => {
  try {
    const {
      itemId,
      quantity,
      deliveryDate,
      deliveryAddress,
      message,
    } = req.body;
    const customerEmail = req.user.email;

    // Validate required fields
    if (
      !itemId ||
      !customerEmail ||
      !quantity ||
      !deliveryDate ||
      !deliveryAddress
    ) {
      return res.status(400).send({
        message: "Please provide all required order information",
      });
    }

    if (!ObjectId.isValid(itemId)) {
      return res.status(400).send({
        message: "Invalid menu item ID",
      });
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).send({
        message: "Quantity must be a positive number",
      });
    }

    if (!deliveryAddress.trim() || Number.isNaN(new Date(deliveryDate).getTime())) {
      return res.status(400).send({
        message: "Valid delivery date and address are required",
      });
    }

    // Find customer
    const customer = await usersCollection.findOne({
      email: customerEmail,
    });

    if (!customer) {
      return res.status(404).send({
        message: "Customer not found",
      });
    }

    if (customer.role !== "customer") {
      return res.status(403).send({
        message: "Only customers can place orders",
      });
    }

    // Find menu item
    const item = await menuCollection.findOne({
      _id: new ObjectId(itemId),
      status: "approved",
      available: true,
    });

    if (!item) {
      return res.status(404).send({
        message: "Pizza is not available for ordering",
      });
    }

    // Find vendor
    const vendor = await usersCollection.findOne({
      email: item.vendorEmail,
    });

    if (!vendor) {
      return res.status(404).send({
        message: "Vendor not found",
      });
    }

    // Calculate price from database
    const totalPrice = Number(item.price) * quantity;

    const order = {
      itemId: item._id,
      itemName: item.name,
      itemImage: item.image,
      vendorId: vendor._id,
      vendorEmail: vendor.email,
      customerId: customer._id,
      customerName: customer.name,
      customerEmail: customer.email,
      quantity,
      unitPrice: Number(item.price),
      totalPrice,
      deliveryDate: new Date(deliveryDate),
      deliveryAddress,
      message: message || "",
      status: "pending",
      createdAt: new Date(),
    };

    const result = await ordersCollection.insertOne(order);

    // Create notification for admins
    try {
      const admins = await usersCollection
        .find(
          { role: "admin" },
          {
            projection: {
              email: 1,
              notificationPreferences: 1,
            },
          },
        )
        .toArray();

      const adminNotifications = admins
        .filter((admin) => admin.notificationPreferences?.newOrders !== false)
        .map((admin) => ({
          recipientEmail: admin.email,
          title: "New Order Received",
          message: `${customer.name} placed a new order for ${item.name}.`,
          type: "new_order",
          relatedId: result.insertedId,
          isRead: false,
          createdAt: new Date(),
        }));

      if (adminNotifications.length > 0) {
        await notificationsCollection.insertMany(adminNotifications);
      }
    } catch (notificationError) {
      console.error("Failed to create order notification:", notificationError);
    }

    res.status(201).send({
      message: "Order placed successfully",
      insertedId: result.insertedId,
      totalPrice,
    });
  } catch (error) {
    console.error("Failed to place order:", error);

    res.status(500).send({
      message: "Failed to place order",
    });
  }
});

// Customer My Orders API
app.get("/orders/customer/:email", verifyToken, requireRole("customer"), async (req, res) => {
  try {
    const { email } = req.params;

    if (email !== req.user.email) {
      return res.status(403).send({ message: "Access denied" });
    }

    const orders = await ordersCollection
      .find({ customerEmail: req.user.email })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(orders);
  } catch (error) {
    console.error("Failed to fetch customer orders:", error);

    res.status(500).send({
      message: "Failed to fetch customer orders",
    });
  }
});

// Customer Cancel Order API

app.patch("/orders/:id/cancel", verifyToken, requireRole("customer"), async (req, res) => {
  try {
    const { id } = req.params;
    const customerEmail = req.user.email;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid order ID",
      });
    }

    // Find order
    const order = await ordersCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!order) {
      return res.status(404).send({
        message: "Order not found",
      });
    }

    // Check order ownership
    if (order.customerEmail !== customerEmail) {
      return res.status(403).send({
        message: "You cannot cancel this order",
      });
    }

    // Only pending orders can be cancelled
    if (order.status !== "pending") {
      return res.status(400).send({
        message: "Only pending orders can be cancelled",
      });
    }

    await ordersCollection.updateOne(
      { _id: new ObjectId(id), customerEmail: req.user.email, status: "pending" },
      {
        $set: {
          status: "cancelled",
          updatedAt: new Date(),
        },
      },
    );

    res.send({
      message: "Order cancelled successfully",
    });
  } catch (error) {
    console.error("Failed to cancel order:", error);

    res.status(500).send({
      message: "Failed to cancel order",
    });
  }
});

// vendors releted API

// Vendor Orders API
app.get("/orders/vendor/:email", verifyToken, requireRole("vendor"), async (req, res) => {
  try {
    const { email } = req.params;

    if (email !== req.user.email) {
      return res.status(403).send({ message: "Access denied" });
    }

    const orders = await ordersCollection
      .find({ vendorEmail: req.user.email })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(orders);
  } catch (error) {
    console.error("Failed to fetch vendor orders:", error);

    res.status(500).send({
      message: "Failed to fetch vendor orders",
    });
  }
});

// Vendor Accept / Reject Order API
app.patch("/orders/:id/status", verifyToken, requireRole("vendor"), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const vendorEmail = req.user.email;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid order ID" });
    }

    if (!vendorEmail || !["accepted", "rejected"].includes(status)) {
      return res.status(400).send({ message: "Invalid request data" });
    }

    const order = await ordersCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!order) {
      return res.status(404).send({ message: "Order not found" });
    }

    if (order.vendorEmail !== vendorEmail) {
      return res.status(403).send({ message: "You cannot manage this order" });
    }

    if (order.status !== "pending") {
      return res.status(400).send({
        message: "Only pending orders can be updated",
      });
    }

    await ordersCollection.updateOne(
      {
        _id: new ObjectId(id),
        vendorEmail,
        status: "pending",
      },
      {
        $set: {
          status,
          updatedAt: new Date(),
        },
      },
    );

    res.send({
      success: true,
      message: `Order ${status} successfully`,
    });
  } catch (error) {
    console.error("Order status update failed:", error);
    res.status(500).send({ message: "Failed to update order status" });
  }
});

// Vendor Profile API

// Get Vendor Profile
app.get("/vendor/profile/:email", verifyToken, requireRole("vendor"), async (req, res) => {
  try {
    const { email } = req.params;

    if (email !== req.user.email) {
      return res.status(403).send({ message: "Access denied" });
    }

    const vendor = await usersCollection.findOne(
      { email: req.user.email, role: "vendor" },
      {
        projection: {
          name: 1,
          email: 1,
          phone: 1,
          restaurantName: 1,
          location: 1,
          description: 1,
          profileImage: 1,
          restaurantLogo: 1,
          subscriptionPlan: 1,
          subscriptionExpiresAt: 1,
        },
      },
    );

    if (!vendor) {
      return res.status(404).send({
        message: "Vendor not found",
      });
    }

    res.send(vendor);
  } catch (error) {
    console.error("Failed to fetch vendor profile:", error);

    res.status(500).send({
      message: "Failed to fetch vendor profile",
    });
  }
});

// Update Vendor Profile
app.patch("/vendor/profile/:email", verifyToken, requireRole("vendor"), async (req, res) => {
  try {
    const { email } = req.params;

    if (email !== req.user.email) {
      return res.status(403).send({ message: "Access denied" });
    }

    const {
      name,
      phone,
      restaurantName,
      location,
      description,
      profileImage,
      restaurantLogo,
    } = req.body;

    if (!name || !phone || !restaurantName || !location) {
      return res.status(400).send({
        message: "Please provide all required profile information",
      });
    }

    const updateData = {
      name,
      phone,
      restaurantName,
      location,
      description: description || "",
      updatedAt: new Date(),
    };

    // Update images only when fields are provided
    if (Object.hasOwn(req.body, "profileImage")) {
      updateData.profileImage = profileImage;
    }

    if (Object.hasOwn(req.body, "restaurantLogo")) {
      updateData.restaurantLogo = restaurantLogo;
    }

    const result = await usersCollection.updateOne(
      { email: req.user.email, role: "vendor" },
      {
        $set: updateData,
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        message: "Vendor not found",
      });
    }

    res.send({
      success: true,
      message: "Profile updated successfully",
    });
  } catch (error) {
    console.error("Failed to update vendor profile:", error);

    res.status(500).send({
      message: "Failed to update vendor profile",
    });
  }
});

// Admin Platform Statistics API
app.get("/admin/platform-stats", verifyToken,requireRole("admin"), async (req, res) => {
  try {
    const [totalVendors, totalOrders] = await Promise.all([
      usersCollection.countDocuments({ role: "vendor" }),
      ordersCollection.countDocuments(),
    ]);

    res.send({
      totalVendors,
      totalOrders,
    });
  } catch (error) {
    console.error("Failed to fetch platform statistics:", error);

    res.status(500).send({
      message: "Failed to fetch platform statistics",
    });
  }
});

// Admin Dashboard API
app.get("/admin/dashboard", verifyToken , requireRole("admin"), async (req, res) => {
  try {
    const currentDate = new Date();

    const sixMonthsAgo = new Date(
      currentDate.getFullYear(),
      currentDate.getMonth() - 5,
      1,
    );

    const [
      totalUsers,
      totalVendors,
      totalOrders,
      pendingMenuApprovals,
      pendingOrders,
      premiumVendors,
      recentOrders,
      vendorPerformance,
      monthlyOrderValues,
    ] = await Promise.all([
      // Total Customers
      usersCollection.countDocuments(),

      // Total Vendors
      usersCollection.countDocuments({ role: "vendor" }),

      // Total Orders
      ordersCollection.countDocuments(),

      // Pending Menu Approvals
      menuCollection.countDocuments({ status: "pending" }),

      // Pending Orders
      ordersCollection.countDocuments({ status: "pending" }),

      // Active Premium Vendors
      usersCollection.countDocuments({
        role: "vendor",
        subscriptionPlan: "premium",
      }),

      // Recent Orders
      ordersCollection.find().sort({ createdAt: -1 }).limit(5).toArray(),

      // Top Vendor Performance
      ordersCollection
        .aggregate([
          {
            $group: {
              _id: "$vendorEmail",
              totalOrders: { $sum: 1 },
              totalOrderValue: { $sum: "$totalPrice" },
            },
          },
          {
            $sort: { totalOrders: -1 },
          },
          {
            $limit: 5,
          },
        ])
        .toArray(),

      // Monthly Order Values (Last 6 Months)
      ordersCollection
        .aggregate([
          {
            $match: {
              createdAt: { $gte: sixMonthsAgo },
              status: { $ne: "cancelled" },
            },
          },
          {
            $group: {
              _id: {
                year: { $year: "$createdAt" },
                month: { $month: "$createdAt" },
              },
              totalOrderValue: { $sum: "$totalPrice" },
              totalOrders: { $sum: 1 },
            },
          },
          {
            $sort: {
              "_id.year": 1,
              "_id.month": 1,
            },
          },
        ])
        .toArray(),
    ]);

    // Get Vendor Information
    const topVendors = await Promise.all(
      vendorPerformance.map(async (vendor) => {
        const vendorInfo = await usersCollection.findOne(
          { email: vendor._id },
          {
            projection: {
              name: 1,
              restaurantName: 1,
              email: 1,
            },
          },
        );

        return {
          email: vendor._id,
          name: vendorInfo?.restaurantName || vendorInfo?.name || "Unknown",
          totalOrders: vendor.totalOrders,
          totalOrderValue: vendor.totalOrderValue,
        };
      }),
    );

    // Format Monthly Data
    const monthlyRevenue = monthlyOrderValues.map((item) => ({
      month: new Date(item._id.year, item._id.month - 1).toLocaleString(
        "en-US",
        { month: "short" },
      ),
      year: item._id.year,
      totalOrderValue: item.totalOrderValue,
      totalOrders: item.totalOrders,
    }));

    res.status(200).send({
      statistics: {
        totalUsers,
        totalVendors,
        totalOrders,
        pendingMenuApprovals,
        pendingOrders,
        premiumVendors,
      },
      recentOrders,
      topVendors,
      monthlyRevenue,
    });
  } catch (error) {
    console.error("Failed to fetch admin dashboard:", error);

    res.status(500).send({
      message: "Failed to fetch admin dashboard data",
    });
  }
});

// Get Admin Notifications
app.get("/admin/notifications/:email", verifyToken, requireRole("admin"), async (req, res) => {
  try {
    const { email } = req.params;

    if (email !== req.user.email) {
      return res.status(403).send({ message: "Access denied" });
    }

    const notifications = await notificationsCollection
      .find({ recipientEmail: req.user.email })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    const unreadCount = await notificationsCollection.countDocuments({
      recipientEmail: req.user.email,
      isRead: false,
    });

    res.send({
      notifications,
      unreadCount,
    });
  } catch (error) {
    console.error("Failed to fetch notifications:", error);

    res.status(500).send({
      message: "Failed to fetch notifications",
    });
  }
});

// Mark Admin Notification as Read
app.patch("/admin/notifications/:id/read/:email", verifyToken, requireRole("admin"), async (req, res) => {
  try {
    const { id, email } = req.params;

    if (email !== req.user.email) {
      return res.status(403).send({ message: "Access denied" });
    }


    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid notification ID",
      });
    }

    const result = await notificationsCollection.updateOne(
      {
        _id: new ObjectId(id),
        recipientEmail: req.user.email,
      },
      {
        $set: {
          isRead: true,
        },
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        message: "Notification not found",
      });
    }

    res.send({
      success: true,
      message: "Notification marked as read",
    });
  } catch (error) {
    console.error("Failed to mark notification as read:", error);

    res.status(500).send({
      message: "Failed to update notification",
    });
  }
});

// Mark Admin Notification as Unread
app.patch("/admin/notifications/:id/unread/:email", verifyToken, requireRole("admin"), async (req, res) => {
  try {
    const { id, email } = req.params;

    if (email !== req.user.email) {
      return res.status(403).send({ message: "Access denied" });
    }


    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid notification ID",
      });
    }

    const result = await notificationsCollection.updateOne(
      {
        _id: new ObjectId(id),
        recipientEmail: req.user.email,
      },
      {
        $set: {
          isRead: false,
        },
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        message: "Notification not found",
      });
    }

    res.send({
      success: true,
      message: "Notification marked as unread",
    });
  } catch (error) {
    console.error("Failed to mark notification as unread:", error);

    res.status(500).send({
      message: "Failed to update notification",
    });
  }
});

// Delete Admin Notification
app.delete("/admin/notifications/:id/:email", verifyToken, requireRole("admin"), async (req, res) => {
  try {
    const { id, email } = req.params;

    if (email !== req.user.email) {
      return res.status(403).send({ message: "Access denied" });
    }


    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid notification ID",
      });
    }

    const result = await notificationsCollection.deleteOne({
      _id: new ObjectId(id),
      recipientEmail: req.user.email,
    });

    if (result.deletedCount === 0) {
      return res.status(404).send({
        message: "Notification not found",
      });
    }

    res.send({
      success: true,
      message: "Notification deleted successfully",
    });
  } catch (error) {
    console.error("Failed to delete notification:", error);

    res.status(500).send({
      message: "Failed to delete notification",
    });
  }
});

// Get all orders for Admin
app.get("/admin/orders", verifyToken , requireRole("admin"), async (req, res) => {
  try {
    const orders = await ordersCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.send(orders);
  } catch (error) {
    console.error("Failed to fetch admin orders:", error);

    res.status(500).send({
      message: "Failed to fetch orders",
    });
  }
});

// Connect to MongoDB first, then start the server
async function startServer() {
  try {
    await connectToMongoDB();

    app.listen(PORT, () => {
      console.log(`PizzaHub server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server failed to start:", error);
    process.exit(1);
  }
}

startServer();
