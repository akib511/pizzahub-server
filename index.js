import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import express from "express";
import cors from "cors";

const app = express();
let menuCollection;
let usersCollection;
let ordersCollection;
let notificationsCollection;
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

const client = new MongoClient(
  `mongodb://${process.env.MONGODB_USER}:${process.env.MONGODB_PASS}@ac-xbq99wb-shard-00-00.exnfvgb.mongodb.net:27017,ac-xbq99wb-shard-00-01.exnfvgb.mongodb.net:27017,ac-xbq99wb-shard-00-02.exnfvgb.mongodb.net:27017/?ssl=true&replicaSet=atlas-p0qrbv-shard-0&authSource=admin`,
);

export async function connectToMongoDB() {
  try {
    await client.connect();

    const db = client.db("PizzaHub");

    menuCollection = db.collection("menuItems");
    ordersCollection = db.collection("orders");
    const transactionsCollection = db.collection("transactions");
    notificationsCollection = db.collection("notifications");
    usersCollection = db.collection("user");

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
  } catch (err) {
    console.error("MongoDB connection failed:", err);
  }
}

connectToMongoDB();

// Test route
app.get("/", (req, res) => {
  res.send("PizzaHub Server is Running!");
});

// menu releted API-----

// Get all menu items
app.get("/menu", async (req, res) => {
  try {
    const result = await menuCollection.find().toArray();

    res.status(200).send(result);
  } catch (error) {
    console.error("Failed to fetch menu:", error);

    res.status(500).send({
      message: "Failed to fetch menu items",
    });
  }
});

// Add new menu item
app.post("/menu", async (req, res) => {
  try {
    const newItem = req.body;

    if (!newItem.name || !newItem.price || !newItem.category) {
      return res.status(400).send({
        message: "Name, price and category are required",
      });
    }

    if (!newItem.vendorEmail) {
      return res.status(400).send({
        message: "Vendor email is required",
      });
    }

    const vendor = await usersCollection.findOne({
      email: newItem.vendorEmail,
    });

    if (!vendor) {
      return res.status(404).send({
        message: "Vendor not found",
      });
    }

    const menuItem = {
      ...newItem,
      status: "pending",
      available:
        typeof newItem.available === "boolean" ? newItem.available : true,
      createdAt: new Date(),
    };

    const result = await menuCollection.insertOne(menuItem);

    // Create notification for admins
    try {
      const admins = await usersCollection
        .find(
          { role: "admin" },
          { projection: { email: 1, notificationPreferences: 1 } },
        )
        .toArray();

      const adminNotifications = admins
        .filter(
          (admin) => admin.notificationPreferences?.menuApprovals !== false,
        )
        .map((admin) => ({
          recipientEmail: admin.email,
          title: "New Menu Approval Request",
          message: `${vendor.name} submitted "${menuItem.name}" for approval.`,
          type: "menu_approval",
          relatedId: result.insertedId,
          isRead: false,
          createdAt: new Date(),
        }));

      if (adminNotifications.length > 0) {
        await notificationsCollection.insertMany(adminNotifications);
      }
    } catch (notificationError) {
      console.error("Failed to create menu notification:", notificationError);
    }

    res.status(201).send({
      message: "Menu item submitted successfully. Waiting for admin approval.",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Failed to add menu item:", error);

    res.status(500).send({
      message: "Failed to add menu item",
    });
  }
});

// Delete menu item
app.delete("/menu/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid menu item ID",
      });
    }

    const result = await menuCollection.deleteOne({
      _id: new ObjectId(id),
    });

    if (result.deletedCount === 0) {
      return res.status(404).send({
        message: "Menu item not found",
      });
    }

    res.status(200).send({
      message: "Menu item deleted successfully",
    });
  } catch (error) {
    console.error("Failed to delete menu item:", error);

    res.status(500).send({
      message: "Failed to delete menu item",
    });
  }
});

// Update menu item
app.patch("/menu/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const updatedItem = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid menu item ID",
      });
    }

    const result = await menuCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: updatedItem,
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        message: "Menu item not found",
      });
    }

    res.status(200).send({
      message: "Menu item updated successfully",
    });
  } catch (error) {
    console.error("Failed to update menu item:", error);
    res.status(500).send({
      message: "Failed to update menu item",
    });
  }
});

// Update menu item availability (eye)
app.patch("/menu/:id/availability", async (req, res) => {
  try {
    const id = req.params.id;
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
    });

    if (!item) {
      return res.status(404).send({
        message: "Menu item not found",
      });
    }

    // Limit check only when making an item available
    if (available === true) {
      const vendor = await usersCollection.findOne({
        email: item.vendorEmail,
      });

      if (!vendor) {
        return res.status(404).send({
          message: "Vendor not found",
        });
      }

      const isPremium =
        vendor.subscriptionPlan === "premium" &&
        vendor.subscriptionExpiresAt &&
        new Date(vendor.subscriptionExpiresAt) > new Date();

      if (!isPremium) {
        const activeItems = await menuCollection.countDocuments({
          vendorEmail: item.vendorEmail,
          status: "approved",
          available: true,
          _id: { $ne: new ObjectId(id) },
        });

        if (activeItems >= 3) {
          return res.status(403).send({
            message:
              "Free vendors can have only 3 active menu items. Upgrade to Premium for unlimited items.",
          });
        }
      }
    }

    await menuCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: { available },
      },
    );

    res.status(200).send({
      message: "Menu availability updated successfully",
    });
  } catch (error) {
    console.error("Failed to update availability:", error);

    res.status(500).send({
      message: "Failed to update menu availability",
    });
  }
});

//admin releted API


// Admin approve or reject menu item
app.patch("/admin/menu/:id/status", async (req, res) => {
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
      });

      if (!vendor) {
        return res.status(404).send({
          message: "Vendor not found",
        });
      }

      const isPremium =
        vendor.subscriptionPlan === "premium" &&
        vendor.subscriptionExpiresAt &&
        new Date(vendor.subscriptionExpiresAt) > new Date();

      const activeItems = await menuCollection.countDocuments({
        vendorEmail: item.vendorEmail,
        status: "approved",
        available: true,
      });

      if (item.available !== false) {
        if (isPremium || activeItems < 3) {
          available = true;
        } else {
          limitReached = true;
        }
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

// Get Admin Notification Preferences
app.get("/admin/preferences/:email", async (req, res) => {
  try {
    const { email } = req.params;

    const admin = await usersCollection.findOne(
      { email, role: "admin" },
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
app.patch("/admin/preferences/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const { newOrders, vendorApplications, menuApprovals, transactions } =
      req.body;

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
      { email, role: "admin" },
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

//customer er API

// Customer Place Order API
app.post("/orders", async (req, res) => {
  try {
    const {
      itemId,
      customerEmail,
      quantity,
      deliveryDate,
      deliveryAddress,
      message,
    } = req.body;

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

    // Find customer
    const customer = await usersCollection.findOne({
      email: customerEmail,
    });

    if (!customer) {
      return res.status(404).send({
        message: "Customer not found",
      });
    }

    if (["vendor", "admin"].includes(customer.role)) {
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
    .filter(
      (admin) => admin.notificationPreferences?.newOrders !== false,
    )
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
app.get("/orders/customer/:email", async (req, res) => {
  try {
    const { email } = req.params;

    const orders = await ordersCollection
      .find({ customerEmail: email })
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

app.patch("/orders/:id/cancel", async (req, res) => {
  try {
    const { id } = req.params;
    const { customerEmail } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid order ID",
      });
    }

    if (!customerEmail) {
      return res.status(400).send({
        message: "Customer email is required",
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
      { _id: new ObjectId(id) },
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
app.get("/orders/vendor/:email", async (req, res) => {
  try {
    const { email } = req.params;

    const orders = await ordersCollection
      .find({ vendorEmail: email })
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
app.patch("/orders/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { vendorEmail, status } = req.body;

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
app.get("/vendor/profile/:email", async (req, res) => {
  try {
    const { email } = req.params;

    const vendor = await usersCollection.findOne(
      { email, role: "vendor" },
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
app.patch("/vendor/profile/:email", async (req, res) => {
  try {
    const { email } = req.params;

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

    const result = await usersCollection.updateOne(
      { email, role: "vendor" },
      {
        $set: {
          name,
          phone,
          restaurantName,
          location,
          description: description || "",
          profileImage,
          restaurantLogo,
          updatedAt: new Date(),
        },
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
app.get("/admin/platform-stats", async (req, res) => {
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


// Get Admin Notifications
app.get("/admin/notifications/:email", async (req, res) => {
  try {
    const { email } = req.params;

    const notifications = await notificationsCollection
      .find({ recipientEmail: email })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    const unreadCount = await notificationsCollection.countDocuments({
      recipientEmail: email,
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
app.patch("/admin/notifications/:id/read/:email", async (req, res) => {
  try {
    const { id, email } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid notification ID",
      });
    }

    const result = await notificationsCollection.updateOne(
      {
        _id: new ObjectId(id),
        recipientEmail: email,
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
app.patch("/admin/notifications/:id/unread/:email", async (req, res) => {
  try {
    const { id, email } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid notification ID",
      });
    }

    const result = await notificationsCollection.updateOne(
      {
        _id: new ObjectId(id),
        recipientEmail: email,
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
app.delete("/admin/notifications/:id/:email", async (req, res) => {
  try {
    const { id, email } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid notification ID",
      });
    }

    const result = await notificationsCollection.deleteOne({
      _id: new ObjectId(id),
      recipientEmail: email,
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


app.listen(PORT, () => {
  console.log(`PizzaHub server running on port ${PORT}`);
});
