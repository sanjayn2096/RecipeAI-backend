const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
require("dotenv").config();


const logger = functions.logger;

// Initialize Firebase Admin with correct project settings
admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: process.env.DATABASE_URL 
});
const db = admin.firestore();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// ==============================
// 🔹 USER AUTHENTICATION 🔹
// ==============================

// Middleware to verify Firebase token
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Missing or invalid token" });
    }

    const token = authHeader.split(" ")[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.userId = decodedToken.uid;
        req.userRef = db.collection("users").doc(req.userId);
        next();
    } catch (error) {
        return res.status(401).json({ error: "Invalid token", details: error.message });
    }
};

// Signup API
app.post("/signup", async (req, res) => {
    const { email, password, firstName, lastName } = req.body;

    if (!email || !password || !firstName || !lastName) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        // Check if user already exists
        const usersRef = db.collection("users");
        const querySnapshot = await usersRef.where("email", "==", email).get();
        if (!querySnapshot.empty) {
            return res.status(409).json({ error: "User with email already exists" });
        }

        // Create user in Firebase Auth
        const user = await admin.auth().createUser({
            email,
            password,
            displayName: `${firstName} ${lastName}`
        });

        // Store user data in Firestore
        await db.collection("users").doc(user.uid).set({
            email,
            firstName,
            lastName,
            favorite_recipes: [],
            created_recipes: []
        });

        return res.status(201).json({ message: "User created successfully", userId: user.uid });
    } catch (error) {
        logger.error("Error creating user:", error);
        return res.status(400).json({ message: error.message });
    }
});

// Delete All Users (for testing purposes)
app.post("/delete_users", async (req, res) => {
    try {
        const listUsersResult = await admin.auth().listUsers();
        const deletePromises = listUsersResult.users.map(user => admin.auth().deleteUser(user.uid));
        await Promise.all(deletePromises);
        return res.status(200).json({ message: "All users deleted successfully" });
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }
});

// Login API (Frontend should handle authentication)
app.post("/login", async (req, res) => {
    try {
        const { email, token_id } = req.body;
        const user = await admin.auth().getUserByEmail(email);
        //write session id to user document
        await db.collection("users").doc(user.uid).update({ session_id: token_id });
        return res.status(200).json({ message: "User logged in", userId: user.uid });
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }
});

// Login API (Frontend should handle authentication)
app.post("/signout", async (req, res) => {
    try {
        const { email } = req.body;
        const userRecord = await admin.auth().getUserByEmail(email);
        console.log("User Record:", userRecord);
        const user = await db.collection("users").where("email", "==", email).get();
        const userId = user.docs[0].id
        await db.collection("users").doc(userId).update({ session_id: "" });
        return res.status(200).json({ message: "User logged out", userId: user.uid });
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }
});

app.get("/fetch-user-details", async (req, res) => {
    try {
        const email = req.query.email;  // Use req.query for GET requests
        if (!email) {
            return res.status(400).json({ message: "Email is required" });
        }

        const userData = await db.collection("users").where("email", "==", email).get();
        if (userData.empty) {
            return res.status(404).json({ message: "User not found" });
        } else {
            const user = userData.docs[0].data();
            return res.status(200).json({
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                favorite_recipes: user.favorite_recipes || [],
                created_recipes: user.created_recipes || []
            });
        }
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
});

app.post("/check-session", async (req, res) => {
    try {
        console.log("Request Body:", req.body); // Log entire request body
        const { sessionId } = req.body;
        console.log("Extracted sessionId:", sessionId); // Log extracted sessionId

        if (!sessionId) {
            return res.status(400).json({ message: "Session ID is missing or undefined" });
        }

        const userSnapshot = await db.collection("users").where("session_id", "==", sessionId).get();
        
        if (userSnapshot.empty) {
            return res.status(401).json({ message: "Invalid session" });
        } else {
            return res.status(200).json({ message: "Session valid", userId: userSnapshot.docs[0].id });
        }
    } catch (error) {
        console.error("Error checking session:", error);
        return res.status(500).json({ message: error.message });
    }
});

// ==============================
// 🔹 FAVORITE RECIPES 🔹
// ==============================

// Save Favorite Recipe
app.post("/save-favorites", async (req, res) => {
    const { userId, recipes } = req.body;

    if (!userId || !recipes.recipeId) {
        return res.status(400).json({ error: "Missing userId or recipeId" });
    }

    try {
        
        const userRef = db.collection("users").doc(userId);
       
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            return res.status(404).json({ error: "User not found" });
        }

        console.log("Recipes:", recipes);

        if(!recipes.isFavorite) { //remove from favorites
            await userRef.update({
                favorite_recipes: admin.firestore.FieldValue.arrayRemove(recipes)
            });
            return res.status(200).json({ message: "Recipe removed from favorites" }); 
        } else {
            await userRef.update({
                favorite_recipes: admin.firestore.FieldValue.arrayUnion(recipes)
            });
            return res.status(200).json({ message: "Recipe added to favorites" });
        }
    } catch (error) {
        logger.error("Error saving favorite recipe:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
});


//Fetch Favorite Recipes
app.get("/fetch-favorites/:userId", async (req, res) => {
    const { userId } = req.params;

    if (!userId) {
        return res.status(400).json({ error: "Missing userId" });
    }

    try {
        const userRef = db.collection("users").doc(userId);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            return res.status(404).json({ error: "User not found" });
        }

        const userData = userDoc.data();
        const favoriteRecipes = userData.favorite_recipes || [];

        return res.status(200).json({ favoriteRecipes });
    } catch (error) {
        logger.error("Error fetching favorite recipes:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
});


// ==============================
// 🔹 ADDING NEW RECIPES 🔹
// ==============================

app.post("/add_recipe", verifyToken, async (req, res) => {
    const { title, ingredients, instructions, image_url = "" } = req.body;

    if (!title || !ingredients || !instructions) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    const recipeRef = db.collection("recipes").doc();
    const recipeData = {
        recipe_id: recipeRef.id,
        user_id: req.userId,
        title,
        ingredients,
        instructions,
        image_url
    };

    await recipeRef.set(recipeData);

    const userDoc = await req.userRef.get();
    if (userDoc.exists) {
        const userData = userDoc.data();
        const createdRecipes = userData.created_recipes || [];
        createdRecipes.push(recipeRef.id);
        await req.userRef.update({ created_recipes: createdRecipes });
    }

    return res.status(201).json({ message: "Recipe added successfully", recipe_id: recipeRef.id });
});

// ==============================
// 🔹 EXPORT FIREBASE FUNCTION 🔹
// ==============================

exports.api = functions.https.onRequest(app);
