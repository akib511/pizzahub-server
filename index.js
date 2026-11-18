import { MongoClient } from 'mongodb';
import "dotenv/config";
import express from "express";
import cors from "cors";

const app = express();
let menuCollection;
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());



const client = new MongoClient(
  `mongodb://${process.env.MONGODB_USER}:${process.env.MONGODB_PASS}@ac-xbq99wb-shard-00-00.exnfvgb.mongodb.net:27017,ac-xbq99wb-shard-00-01.exnfvgb.mongodb.net:27017,ac-xbq99wb-shard-00-02.exnfvgb.mongodb.net:27017/?ssl=true&replicaSet=atlas-p0qrbv-shard-0&authSource=admin`
);

export async function connectToMongoDB() {
  try {
    await client.connect();

    const db = client.db("PizzaHub");

     menuCollection = db.collection("menuItems");
    const ordersCollection = db.collection("orders");
    const transactionsCollection = db.collection("transactions");

    console.log("MongoDB Connected Successfully!");
    console.log("Database: PizzaHub");

    return {
      client,
      db,
      menuCollection,
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


// menu releted API

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

    const result = await menuCollection.insertOne(newItem);

    res.status(201).send({
      message: "Menu item added successfully",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Failed to add menu item:", error);

    res.status(500).send({
      message: "Failed to add menu item",
    });
  }
});




app.listen(PORT, () => {
  console.log(`PizzaHub server running on port ${PORT}`);
});