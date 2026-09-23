const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

// Needed so req.protocol / req.get("host") are correct behind a proxy
// (ngrok, Render, Railway, Nginx) when building the PayHero callback URL.
app.set("trust proxy", true);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------
// Static files (public/index.html is the delivery fee page)
// ---------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------
// PayHero API routes  ->  /api/stk-push, /api/check-status,
//                         /api/payhero-callback
// ---------------------------------------------------------------------
const payheroRoutes = require("./routes/payhero");
app.use("/api", payheroRoutes);

// Health check — handy for uptime monitors and for confirming deploys
app.get("/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
});

// Homepage = the delivery fee page
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------------------------------------------------------------------
// JSON 404 for unknown /api routes (so the page never gets HTML back
// when it expects JSON), plus a JSON error handler
// ---------------------------------------------------------------------
app.use("/api", (req, res) => {
    res.status(404).json({ success: false, message: "API route not found" });
});

app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
});

// Port the server listens on. Change 3000 here if you need another port.
const PORT = 3000;

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = app;
