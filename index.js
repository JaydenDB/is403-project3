require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");
const OpenAI = require("openai");

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

const port = process.env.PORT || 3001;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
    session({
        secret: process.env.SESSION_SECRET || "fallback-secret-key",
        resave: false,
        saveUninitialized: false,
    })
);

// ==========================
// ✅ KNEX CONNECTION
// ==========================
const knex = require("knex")({
    client: "pg",
    connection: {
        host : process.env.DB_HOST || "project3database.cy708im2qmf7.us-east-1.rds.amazonaws.com",
        user : process.env.DB_USER || "postgres",
        password : process.env.DB_PASSWORD || "project3password",
        database : process.env.DB_NAME || "project3database",
        port : process.env.DB_PORT || 5432 
    }
});

// ==========================
// ✅ SESSION AVAILABLE TO EJS
// ==========================
app.use((req, res, next) => {
    res.locals.session = req.session;
    next();
});

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

        if (!user)
            return res.render("index", { error: "Invalid username or password" });

        req.session.user = {
            id: user.user_id,
            username: user.username,
            firstName: user.cust_first_name,
            lastName: user.cust_last_name,
            level: user.level,
        };

        res.redirect("/dashboard");
    } catch (err) {
        console.error(err);
        res.render("index", { error: "Server error" });
    }
});

// ==========================
// ✅ REGISTER NEW USER
// ==========================
app.post("/register", async (req, res) => {
    const {
        username,
        password,
        email,
        phone_number,
        cust_first_name,
        cust_last_name,
    } = req.body;

    try {
        const existing = await knex("security").where("username", username).first();
        if (existing)
            return res.render("index", { error: "Username already exists" });

        // Insert into security first
        const [newUser] = await knex("security")
            .insert({ username, password, email, phone_number })
            .returning("*");

        // Insert into customers minimal info
        await knex("customers").insert({
            user_id: newUser.user_id,
            cust_first_name,
            cust_last_name,
        });

        req.session.user = {
            id: newUser.user_id,
            username,
            firstName: cust_first_name,
            lastName: cust_last_name,
            level: newUser.level,
        };

        res.redirect("/firsttime");
    } catch (err) {
        console.error(err);
        res.render("index", { error: "Error registering user." });
    }
});

// ==========================
// ✅ FIRST-TIME USER PROFILE
// ==========================
app.get("/firsttime", (req, res) => {
    if (!req.session.user) return res.redirect("/");
    res.render("firsttime", { error: null });
});

app.post("/firsttime", async (req, res) => {
    if (!req.session.user) return res.redirect("/");

    const {
        cust_age,
        cust_weight,
        cust_height,
        cust_gender,
        cust_date_of_birth,
    } = req.body;

    try {
        await knex("customers")
            .where("user_id", req.session.user.id)
            .update({
                cust_age: cust_age || null,
                cust_weight: cust_weight || null,
                cust_height: cust_height || null,
                cust_gender: cust_gender || null,
                cust_date_of_birth: cust_date_of_birth || null,
            });

        res.redirect("/chatgpt");
    } catch (err) {
        console.error(err);
        res.render("firsttime", { error: "Failed to save profile." });
    }
});

// ==========================
// ✅ DASHBOARD (with weekly chart)
// ==========================
app.get("/dashboard", async (req, res) => {
    if (!req.session.user) return res.redirect("/");

    const userId = req.session.user.id;

    try {
        const today = new Date();
        const todayStr = today.toISOString().slice(0, 10);

        const weekOffset = parseInt(req.query.weekOffset || "0", 10);

        const endDate = new Date(today);
        endDate.setDate(endDate.getDate() - weekOffset * 7);

        const startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - 6);

        const startStr = startDate.toISOString().slice(0, 10);
        const endStr = endDate.toISOString().slice(0, 10);

        // 1) Top cards: today's workouts and foods
        const todayWorkouts = await knex("workout_log")
            .join("workouts", "workout_log.workout_id", "workouts.workout_id")
            .where("workout_log.cust_id", userId)
            .andWhere("workout_log.log_date", todayStr)
            .select(
                "workouts.workout_name",
                "workout_log.calories_burned",
                "workout_log.workout_streak"
            );

        const todayFoods = await knex("food_log")
            .join("foods", "food_log.food_id", "foods.food_id")
            .where("food_log.cust_id", userId)
            .andWhere("food_log.log_date", todayStr)
            .select(
                "foods.food_name",
                "foods.calories",
                "food_log.calorie_goal",
                "food_log.total_weight_lost"
            );

        const goalEntry = await knex("food_log")
            .where("cust_id", userId)
            .orderBy("log_date", "desc")
            .orderBy("food_log_id", "desc")
            .first();

        // 2) Weekly data
        const weeklyFoods = await knex("food_log")
            .join("foods", "food_log.food_id", "foods.food_id")
            .where("food_log.cust_id", userId)
            .andWhere("food_log.log_date", ">=", startStr)
            .andWhere("food_log.log_date", "<=", endStr)
            .select(
                "food_log.log_date",
                "foods.food_name",
                "food_log.calorie_goal",
                "food_log.total_weight_lost"
            );

        const weeklyWorkouts = await knex("workout_log")
            .where("cust_id", userId)
            .andWhere("log_date", ">=", startStr)
            .andWhere("log_date", "<=", endStr)
            .select("log_date", "calories_burned");

        const dayMap = {};
        const labels = [];

        for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
            const key = d.toISOString().slice(0, 10);
            const niceLabel = d.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
            });

            dayMap[key] = {
                label: niceLabel,
                eaten: 0,
                burned: 0,
                weight_lost: 0,
                goalCalories: 0,
            };

            labels.push(key);
        }

        weeklyFoods.forEach((row) => {
            const dateKey = row.log_date.toISOString().slice(0, 10);
            const entry = dayMap[dateKey];
            if (!entry) return;

            const isGoal = row.food_name.toLowerCase() === "daily goal";
            const cals = Number(row.calorie_goal || 0);
            const weightLost = Number(row.total_weight_lost || 0);

            if (isGoal) {
                entry.goalCalories += cals;
            } else {
                entry.eaten += cals;
            }

            if (weightLost > entry.weight_lost) {
                entry.weight_lost = weightLost;
            }
        });

        weeklyWorkouts.forEach((row) => {
            const dateKey = row.log_date.toISOString().slice(0, 10);
            const entry = dayMap[dateKey];
            if (!entry) return;
            entry.burned += Number(row.calories_burned || 0);
        });

        const chartLabels = labels.map((key) => dayMap[key].label);
        const eatenArr = labels.map((key) => dayMap[key].eaten);
        const burnedArr = labels.map((key) => dayMap[key].burned);
        const weightLostArr = labels.map((key) => dayMap[key].weight_lost);

        const chartDataWeekly = {
            labels: chartLabels,
            eaten: eatenArr,
            burned: burnedArr,
            weight_lost: weightLostArr,
        };

        res.render("dashboard", {
            todayWorkouts,
            todayFoods,
            goals: goalEntry || {},
            chartDataWeekly,
            weekOffset,
        });
    } catch (err) {
        console.error(err);
        res.send("Error loading dashboard");
    }
});

// ==========================
// ✅ WORKOUT LOG PAGES
// ==========================
app.get("/workout-log", async (req, res) => {
    if (!req.session.user) return res.redirect("/");

    const userId = req.session.user.id;
    const workouts = await knex("workouts").select("*");
    const todayStr = new Date().toISOString().slice(0, 10);

    const todaysLogs = await knex("workout_log")
        .join("workouts", "workout_log.workout_id", "workouts.workout_id")
        .where("workout_log.cust_id", userId)
        .andWhere("workout_log.log_date", todayStr)
        .select(
            "workout_log.workout_log_id",
            "workouts.workout_name",
            "workout_log.calories_burned",
            "workout_log.completed"
        );

    res.render("workout_log", { workouts, todaysLogs });
});

app.post("/workout-log", async (req, res) => {
    if (!req.session.user) return res.redirect("/");

    const { workout_id, workout_streak, calories_burned, heart_rate } = req.body;

    try {
        await knex("workout_log").insert({
            cust_id: req.session.user.id,
            workout_id,
            workout_streak,
            calories_burned,
            heart_rate,
            log_date: new Date().toISOString().slice(0, 10),
            completed: false,
        });

        res.redirect("/workout-log");
    } catch (err) {
        console.error(err);
        res.send("Error saving workout log");
    }
});

app.post("/workout-log/complete/:id", async (req, res) => {
    if (!req.session.user) return res.redirect("/");

    const id = req.params.id;

    try {
        await knex("workout_log")
            .where({ workout_log_id: id, cust_id: req.session.user.id })
            .update({ completed: true });

        res.redirect("/workout-log");
    } catch (err) {
        console.error(err);
        res.send("Error marking workout completed.");
    }
});

// ==========================
// ✅ FOOD LOG PAGES
// ==========================
app.get("/food-log", async (req, res) => {
    if (!req.session.user) return res.redirect("/");

    const userId = req.session.user.id;
    const foods = await knex("foods").select("*");
    const todayStr = new Date().toISOString().slice(0, 10);

    const todaysFoodsRaw = await knex("food_log")
        .join("foods", "food_log.food_id", "foods.food_id")
        .where("food_log.cust_id", userId)
        .andWhere("food_log.log_date", todayStr)
        .select(
            "food_log.food_log_id",
            "foods.food_name",
            "foods.calories",
            "foods.protein",
            "food_log.calorie_goal",
            "food_log.completed"
        );

    const todaysFoods = todaysFoodsRaw.map((row) => ({
        ...row,
        is_goal: row.food_name.toLowerCase() === "daily goal",
    }));

    res.render("food_log", { foods, todaysFoods });
});

app.post("/food-log", async (req, res) => {
    if (!req.session.user) return res.redirect("/");

    const { food_id, calorie_goal, total_weight_lost } = req.body;

    try {
        await knex("food_log").insert({
            cust_id: req.session.user.id,
            food_id,
            calorie_goal,
            total_weight_lost,
            log_date: new Date().toISOString().slice(0, 10),
            completed: true,
        });

        res.redirect("/food-log");
    } catch (err) {
        console.error(err);
        res.send("Error saving food log");
    }
});

app.post("/food-log/add-ai-foods", async (req, res) => {
    if (!req.session.user) return res.json({ error: "Not logged in." });

    const userId = req.session.user.id;
    const { items } = req.body;

    if (!Array.isArray(items) || !items.length) {
        return res.json({ error: "No food items provided." });
    }

    const todayStr = new Date().toISOString().slice(0, 10);

    try {
        for (const item of items) {
            const name = item.name || "Unknown item";
            const calories = item.calories || 0;
            const protein = item.protein_g || 0;
            const carbs = item.carbs_g || 0;
            const fat = item.fat_g || 0;

            let foodRow = await knex("foods")
                .whereRaw("LOWER(food_name) = LOWER(?)", [name])
                .first();

            if (!foodRow) {
                [foodRow] = await knex("foods")
                    .insert({
                        food_name: name,
                        calories,
                        protein,
                        carbs,
                        fat,
                    })
                    .returning("*");
            }

            await knex("food_log").insert({
                cust_id: userId,
                food_id: foodRow.food_id,
                calorie_goal: calories,
                total_weight_lost: 0,
                log_date: todayStr,
                completed: true,
            });
        }

        res.json({ message: "Foods logged for today!" });
    } catch (err) {
        console.error("Error saving AI foods:", err);
        res.json({ error: "Error saving foods." });
    }
});

app.post("/food-log/complete/:id", async (req, res) => {
    if (!req.session.user) return res.redirect("/");

    const id = req.params.id;

    try {
        await knex("food_log")
            .where({ food_log_id: id, cust_id: req.session.user.id })
            .update({ completed: true });

        res.redirect("/food-log");
    } catch (err) {
        console.error(err);
        res.send("Error marking food completed.");
    }
});

// ==========================
// ✅ OPENAI CLIENT
// ==========================
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getUserContextForPlan(userId) {
    const customer = await knex("customers").where("user_id", userId).first();
    const questions = await knex("user_questions").where("cust_id", userId).first();
    return { customer, questions };
}

// ==========================
// ✅ CHATGPT / AI COACH PAGE
// ==========================
app.get("/chatgpt", async (req, res) => {
    if (!req.session.user) return res.redirect("/");

    const userId = req.session.user.id;
    let answers = await knex("user_questions").where("cust_id", userId).first();

    if (!answers) {
        answers = { goals: "", level: "", diet: "", equipment: "", time: "" };
    }

    res.render("chatgpt", { answers });
});

// ==========================
// ✅ UPDATE QUESTIONNAIRE
// ==========================
app.post("/update-questions", async (req, res) => {
    if (!req.session.user) return res.json({ reply: "Not logged in." });

    const userId = req.session.user.id;
    const { goals, level, diet, equipment, time } = req.body;

    try {
        const exists = await knex("user_questions").where("cust_id", userId).first();
        if (exists) {
            await knex("user_questions")
                .where("cust_id", userId)
                .update({ goals, level, equipment, diet, time });
        } else {
            await knex("user_questions").insert({
                cust_id: userId,
                goals,
                level,
                equipment,
                diet,
                time,
            });
        }

        res.json({ reply: "Questionnaire saved successfully!" });
    } catch (err) {
        console.error(err);
        res.json({ reply: "Error saving questionnaire." });
    }
});

// ==========================
// ✅ GENERATE PLAN
// ==========================
app.post("/generate-plan", async (req, res) => {
    if (!req.session.user) return res.json({ error: "Not logged in." });

    const userId = req.session.user.id;

    try {
        const { customer, questions } = await getUserContextForPlan(userId);

        if (!questions) {
            return res.json({ error: "Please fill out your questionnaire first." });
        }

        const prompt = `
You are a fitness planner AI.

User profile:
- Name: ${customer?.cust_first_name || ""} ${
            customer?.cust_last_name || ""
        }
- Age: ${customer?.cust_age || "unknown"}
- Weight (lbs): ${customer?.cust_weight || "unknown"}
- Height (in): ${customer?.cust_height || "unknown"}
- Gender: ${customer?.cust_gender || "unknown"}

Questionnaire:
- Goals: ${questions.goals}
- Fitness level: ${questions.level}
- Diet: ${questions.diet}
- Available equipment: ${questions.equipment}
- Time per day (minutes): ${questions.time}

You MUST respond ONLY with JSON. No backticks. No explanation.

JSON format:
{
  "days": [
    {
      "dayOffset": 0,
      "label": "Day 1",
      "calorie_goal": 2300,
      "protein_goal_g": 150,
      "notes": "Short note about focus for the day",
      "workouts": [
        {
          "name": "Squats",
          "time_block": "morning",
          "approx_calories": 300
        }
      ]
    }
  ]
}

Rules:
- Return exactly 7 days with dayOffset 0..6.
- Always include calorie_goal and protein_goal_g on each day.
- For each day include 1–3 workouts.
- Use realistic exercise names.
- approx_calories is optional, but helpful if you can guess.
`;

        const completion = await client.chat.completions.create({
            model: "gpt-4.1-mini",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
        });

        let raw = completion.choices[0].message.content.trim();

        const firstBrace = raw.indexOf("{");
        const lastBrace = raw.lastIndexOf("}");

        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            raw = raw.slice(firstBrace, lastBrace + 1);
        }

        let plan;
        try {
            plan = JSON.parse(raw);
        } catch (e) {
            console.error("⚠️ Plan JSON parse error:", e);
            console.error("Raw model output was:\n", completion.choices[0].message.content);
            return res.json({ error: "AI did not return valid JSON. Try again." });
        }

        if (!plan.days || !Array.isArray(plan.days) || plan.days.length === 0) {
            console.error("⚠️ Plan structure invalid:", plan);
            return res.json({ error: "AI returned an invalid plan structure." });
        }

        res.json({ plan });
    } catch (err) {
        console.error("Error generating plan:", err);
        res.json({ error: "Error generating plan." });
    }
});

// ==========================
// ✅ SAVE PLAN TO workout_log & food_log
// ==========================
app.post("/save-plan", async (req, res) => {
    if (!req.session.user) return res.json({ error: "Not logged in." });

    const userId = req.session.user.id;
    const { plan } = req.body;

    if (!plan || !Array.isArray(plan.days)) {
        return res.json({ error: "Invalid plan payload." });
    }

    try {
        let dailyGoalFood = await knex("foods")
            .whereRaw("LOWER(food_name) = LOWER('Daily Goal')")
            .first();

        if (!dailyGoalFood) {
            [dailyGoalFood] = await knex("foods")
                .insert({
                    food_name: "Daily Goal",
                    calories: 0,
                    protein: 0,
                    carbs: 0,
                    fat: 0,
                })
                .returning("*");
        }

        const dailyGoalFoodId = dailyGoalFood.food_id;

        const today = new Date();
        const toDateString = (offset) => {
            const d = new Date(today);
            d.setDate(d.getDate() + offset);
            return d.toISOString().slice(0, 10);
        };

        for (const day of plan.days) {
            const offset = day.dayOffset || 0;
            const log_date = toDateString(offset);

            if (Array.isArray(day.workouts)) {
                for (const w of day.workouts) {
                    if (!w.name) continue;

                    let workoutRow = await knex("workouts")
                        .whereRaw("LOWER(workout_name) = LOWER(?)", [w.name])
                        .first();

                    if (!workoutRow) {
                        const guessedBodyPart = (() => {
                            const n = w.name.toLowerCase();
                            if (
                                n.includes("squat") ||
                                n.includes("lunge") ||
                                n.includes("deadlift")
                            )
                                return "Legs";
                            if (n.includes("push") || n.includes("bench")) return "Chest";
                            if (n.includes("row") || n.includes("pull")) return "Back";
                            if (n.includes("curl") || n.includes("bicep")) return "Arms";
                            if (n.includes("tricep") || n.includes("dip")) return "Arms";
                            if (
                                n.includes("shoulder") ||
                                n.includes("press")
                            )
                                return "Shoulders";
                            if (
                                n.includes("plank") ||
                                n.includes("crunch") ||
                                n.includes("core")
                            )
                                return "Core";
                            if (
                                n.includes("run") ||
                                n.includes("cardio") ||
                                n.includes("burpee") ||
                                n.includes("jump")
                            )
                                return "Cardio";
                            return null;
                        })();

                        const guessedEquipment = (() => {
                            const n = w.name.toLowerCase();
                            if (n.includes("dumbbell")) return "Dumbbells";
                            if (n.includes("barbell")) return "Barbell";
                            if (n.includes("machine")) return "Machine";
                            if (n.includes("band")) return "Bands";
                            return "None";
                        })();

                        const guessedDifficulty = "Medium";

                        [workoutRow] = await knex("workouts")
                            .insert({
                                workout_name: w.name,
                                body_part_worked: guessedBodyPart,
                                equipment_needed: guessedEquipment,
                                difficulty: guessedDifficulty,
                            })
                            .returning("*");
                    }

                    await knex("workout_log").insert({
                        cust_id: userId,
                        workout_id: workoutRow.workout_id,
                        workout_streak: 0,
                        calories_burned: w.approx_calories || 0,
                        heart_rate: 0,
                        log_date,
                        completed: false,
                    });
                }
            }

            if (day.calorie_goal) {
                await knex("food_log").insert({
                    cust_id: userId,
                    food_id: dailyGoalFoodId,
                    calorie_goal: day.calorie_goal,
                    total_weight_lost: 0,
                    log_date,
                    completed: false,
                });
            }
        }

        res.json({ message: "Plan saved into your logs!" });
    } catch (err) {
        console.error("Error saving plan:", err);
        res.json({ error: "Error saving plan." });
    }
});

// ==========================
// ✅ FOOD INFO / MACRO SEARCH
// ==========================
app.post("/food-info", async (req, res) => {
    const { query } = req.body;
    if (!query || !query.trim()) {
        return res.json({ error: "Please describe at least one food." });
    }

    try {
        const prompt = `
You are a nutrition assistant.
The user will list one or more foods (with optional quantities).

You MUST respond ONLY with a valid JSON object and NOTHING else.

Format:
{
  "items": [
    {
      "name": "2 eggs",
      "calories": 156,
      "protein_g": 12,
      "carbs_g": 1,
      "fat_g": 11
    }
  ],
  "summary": "Very short plain English recap and any helpful tips."
}

Use reasonable estimates based on common serving sizes and USDA-like data.
User query: ${query}
`;

        const completion = await client.chat.completions.create({
            model: "gpt-4.1-mini",
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
        });

        const raw = completion.choices[0].message.content;
        let data;
        try {
            data = JSON.parse(raw);
        } catch (e) {
            console.error("Food info parse error:", e, raw);
            return res.json({ error: "AI returned invalid format." });
        }

        if (!data.items || !Array.isArray(data.items)) {
            return res.json({ error: "AI did not include an items array." });
        }

        res.json(data);
    } catch (err) {
        console.error("Food info API Error:", err);
        res.json({ error: "AI is having trouble looking up foods right now." });
    }
});

// ==========================
// ✅ GENERAL ASK AI
// ==========================
app.post("/ask-ai", async (req, res) => {
    const { userMessage } = req.body;

    try {
        const completion = await client.chat.completions.create({
            model: "gpt-4.1-mini",
            messages: [{ role: "user", content: userMessage }],
        });

        res.json({ reply: completion.choices[0].message.content });
    } catch (err) {
        console.error("ChatGPT API Error:", err);
        res.json({ reply: "AI is having trouble right now." });
    }
});

// ==========================
// ✅ LOGOUT
// ==========================
app.get("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/"));
});

// ==========================
// ✅ MANAGER-ONLY ROUTES
// ==========================
function requireManager(req, res, next) {
    if (!req.session.user) return res.redirect("/");
    if (req.session.user.level !== "M") return res.status(403).send("Forbidden");
    next();
}

// List all users
app.get("/manager", requireManager, async (req, res) => {
    try {
        const users = await knex("security")
            .join("customers", "security.user_id", "customers.user_id")
            .select(
                "security.user_id",
                "security.username",
                "security.level",
                "security.email",
                "security.phone_number",
                "customers.cust_first_name",
                "customers.cust_last_name"
            )
            .orderBy("security.user_id", "asc");

        res.render("manager", { users, error: null });
    } catch (err) {
        console.error("Manager list error:", err);
        res.render("manager", { users: [], error: "Error loading users" });
    }
});

// Add user
app.post("/manager/add", requireManager, async (req, res) => {
    const {
        username,
        password,
        level,
        cust_first_name,
        cust_last_name,
        email,
        phone_number,
        cust_age,
        cust_weight,
        cust_height,
        cust_gender,
        cust_date_of_birth,
    } = req.body;

    try {
        const existing = await knex("security").where("username", username).first();
        if (existing) {
            return res.redirect("/manager");
        }

        const [newUser] = await knex("security")
            .insert({
                username,
                password,
                level: level || "U",
                email: email || null,
                phone_number: phone_number || null,
            })
            .returning("*");

        await knex("customers").insert({
            user_id: newUser.user_id,
            cust_first_name,
            cust_last_name,
            cust_age: cust_age || null,
            cust_weight: cust_weight || null,
            cust_height: cust_height || null,
            cust_gender: cust_gender || null,
            cust_date_of_birth: cust_date_of_birth || null,
        });

        res.redirect("/manager");
    } catch (err) {
        console.error("Manager add error:", err);
        res.redirect("/manager");
    }
});

// Show a single user's details
app.get("/manager/user/:id", requireManager, async (req, res) => {
    const id = req.params.id;

    try {
        const user = await knex("security")
            .leftJoin("customers", "security.user_id", "customers.user_id")
            .where("security.user_id", id)
            .select(
                "security.user_id",
                "security.username",
                "security.level",
                "security.email",
                "security.phone_number",
                "customers.cust_first_name",
                "customers.cust_last_name",
                "customers.cust_age",
                "customers.cust_weight",
                "customers.cust_height",
                "customers.cust_gender",
                "customers.cust_date_of_birth"
            )
            .first();

        if (!user) return res.status(404).send("User not found");

        const questions = await knex("user_questions").where("cust_id", id).first();

        const foodLogs = await knex("food_log")
            .join("foods", "food_log.food_id", "foods.food_id")
            .where("food_log.cust_id", id)
            .select(
                "food_log.food_log_id",
                "food_log.calorie_goal",
                "food_log.total_weight_lost",
                "food_log.log_date",
                "food_log.completed",
                "foods.food_name"
            )
            .orderBy("food_log.log_date", "desc")
            .limit(50);

        const workoutLogs = await knex("workout_log")
            .join("workouts", "workout_log.workout_id", "workouts.workout_id")
            .where("workout_log.cust_id", id)
            .select(
                "workout_log.workout_log_id",
                "workout_log.workout_streak",
                "workout_log.calories_burned",
                "workout_log.heart_rate",
                "workout_log.log_date",
                "workout_log.completed",
                "workouts.workout_name"
            )
            .orderBy("workout_log.log_date", "desc")
            .limit(50);

        res.render("edit_user", {
            user,
            questions: questions || {},
            foodLogs,
            workoutLogs,
            error: null,
        });
    } catch (err) {
        console.error("Manager user detail error:", err);
        res.status(500).send("Server error");
    }
});

// Update user basic info
app.post("/manager/user/edit/:id", requireManager, async (req, res) => {
    const id = req.params.id;
    const {
        username,
        password,
        level,
        email,
        phone_number,
        cust_first_name,
        cust_last_name,
        cust_age,
        cust_weight,
        cust_height,
        cust_gender,
        cust_date_of_birth,
    } = req.body;

    try {
        await knex.transaction(async (trx) => {
            const securityUpdate = {
                username,
                level,
                email: email || null,
                phone_number: phone_number || null,
            };

            if (password && password.trim() !== "") {
                securityUpdate.password = password;
            }

            await trx("security").where("user_id", id).update(securityUpdate);

            await trx("customers").where("user_id", id).update({
                cust_first_name,
                cust_last_name,
                cust_age: cust_age || null,
                cust_weight: cust_weight || null,
                cust_height: cust_height || null,
                cust_gender: cust_gender || null,
                cust_date_of_birth: cust_date_of_birth || null,
            });
        });

        res.redirect("/manager/user/" + id);
    } catch (err) {
        console.error("Manager edit error:", err);
        res.redirect("/manager/user/" + id);
    }
});

// Delete user and related data
app.post("/manager/user/delete/:id", requireManager, async (req, res) => {
    const id = req.params.id;

    try {
        await knex.transaction(async (trx) => {
            await trx("workout_log").where("cust_id", id).del();
            await trx("food_log").where("cust_id", id).del();
            await trx("user_questions").where("cust_id", id).del();
            await trx("customers").where("user_id", id).del();
            await trx("security").where("user_id", id).del();
        });

        res.redirect("/manager");
    } catch (err) {
        console.error("Manager delete error:", err);
        res.redirect("/manager");
    }
});

app.listen(port, () => console.log("Server running on port", port));
