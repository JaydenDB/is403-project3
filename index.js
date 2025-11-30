const express = require("express");
const session = require("express-session");
let path = require("path");

let app = express();

app.set("view engine", "ejs");

const port = process.env.PORT || 3001;

app.use(
    session({
        secret: process.env.SESSION_SECRET || 'fallback-secret-key',
        resave: false,
        saveUninitialized: false,
    })
);

// ✅ KNEX CONNECTION
const knex = require("knex")({
    client: "pg",
    connection: {
        host : process.env.DB_HOST || "localhost",
        user : process.env.DB_USER || "postgres",
        password : process.env.DB_PASSWORD || "ChPost05$",
        database : process.env.DB_NAME || "Project3",
        port : process.env.DB_PORT || 5432 
    }
});

// ✅ MAKE SESSION AVAILABLE TO EJS
app.use((req, res, next) => {
    res.locals.session = req.session;
    next();
});

app.use(express.urlencoded({ extended: true }));

// ==========================
// ✅ LOGIN PAGE
// ==========================
app.get("/", (req, res) => {
    res.render("index", { error: null });
});

// ==========================
// ✅ HANDLE LOGIN
// ==========================
app.post("/login", async (req, res) => {
    const { username, password } = req.body;

    try {
        const user = await knex("security")
            .join("customers", "security.user_id", "customers.user_id")
            .where("security.username", username)
            .andWhere("security.password", password)
            .select(
                "security.user_id",
                "security.username",
                "customers.cust_first_name",
                "customers.cust_last_name",
                "security.level"
            )
            .first();

        if (!user) {
            return res.render("index", { error: "Invalid username or password" });
        }

        // ✅ SAVE USER TO SESSION
        req.session.user = {
            id: user.user_id,
            username: user.username,
            firstName: user.cust_first_name,
            lastName: user.cust_last_name,
            level: user.level
        };

        res.redirect("/dashboard");

    } catch (err) {
        console.error(err);
        res.render("index", { error: "Server error" });
    }
});

// ==========================
// ✅ DASHBOARD (PROTECTED)
// ==========================
app.get("/dashboard", (req, res) => {
    if (!req.session.user) {
        return res.redirect("/");
    }

    res.render("dashboard");
});

// ==========================
// ✅ WORKOUT LOG PAGE (FORM)
// ==========================
app.get("/workout-log", async (req, res) => {
    if (!req.session.user) return res.redirect("/");

    const workouts = await knex("workouts").select("*");
    res.render("workout_log", { workouts });
});

// ==========================
// ✅ SAVE WORKOUT LOG
// ==========================
app.post("/workout-log", async (req, res) => {
    const { workout_id, workout_streak, calories_burned, heart_rate } = req.body;

    try {
        await knex("workout_log").insert({
            cust_id: req.session.user.id,
            workout_id,
            workout_streak,
            calories_burned,
            heart_rate
        });

        res.redirect("/dashboard");
    } catch (err) {
        console.error(err);
        res.send("Error saving workout log");
    }
});

// ==========================
// ✅ FOOD LOG PAGE (FORM)
// ==========================
app.get("/food-log", async (req, res) => {
    if (!req.session.user) return res.redirect("/");

    const foods = await knex("foods").select("*");
    res.render("food_log", { foods });
});

// ==========================
// ✅ SAVE FOOD LOG
// ==========================
app.post("/food-log", async (req, res) => {
    const { food_id, calorie_goal, total_weight_lost } = req.body;

    try {
        await knex("food_log").insert({
            cust_id: req.session.user.id,
            food_id,
            calorie_goal,
            total_weight_lost
        });

        res.redirect("/dashboard");
    } catch (err) {
        console.error(err);
        res.send("Error saving food log");
    }
});


// ==========================
// ✅ LOGOUT
// ==========================
app.get("/logout", (req, res) => {
    req.session.destroy(() => {
        res.redirect("/");
    });
});

app.listen(port, () => {
    console.log("The server is listening on port", port);
});
