const express = require("express");
const cors = require("cors");
const naukrigulfJobsScraper = require("./NaukriGulf-Scraper");


const app = express();
const PORT = 3000;

const SERVER_TIMEOUT = 3000000;

app.use((req, res, next) => {
  req.setTimeout(SERVER_TIMEOUT);
  res.setTimeout(SERVER_TIMEOUT);
  next();
});

app.use(express.json());

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "X-Authorization"],
    exposedHeaders: ["X-Authorization"]
  })
);

app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});


const errorHandler = (err, req, res, next) => {
  console.error(`[API ERROR] ${err.message}`);
  console.error(err.stack);

  res.status(500).json({
    status: "error",
    code: 500,
    message: err.message || "Unknown error occurred",
  });
};

// ==================== ROUTES ====================

// Health check endpoint
app.get("/", (req, res) => {
  res.status(200).json({
    status: "success",
    code: 200,
    message: "Job Scraper API is running",
    version: "1.0.0",
    endpoints: {
      health: "GET /health",
      scrapeJobs: "POST /naukri-gulf"
    }
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "success",
    code: 200,
    message: "Healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Main scraping endpoint
app.post(
  "/naukri-gulf",
  async (req, res, next) => {
    try {

      const startTime = Date.now();

      const jobs = await naukrigulfJobsScraper();

      const endTime = Date.now();
      const duration = (endTime - startTime) / 1000;

      console.log(`[NAUKRI-GULF] Scraping completed in ${duration.toFixed(2)}s - Found ${jobs.length} jobs`);

      return res.status(200).json({
        status: "success",
        code: 200,
        count: jobs.length,
        data: jobs,
        metadata: {
          scrapedAt: new Date().toISOString(),
          duration: `${duration.toFixed(2)}s`
        }
      });
    } catch (error) {
      console.error("[NAUKRI-GULF ERROR]", error.message);
      console.error(error.stack);

      return res.status(500).json({
        status: "error",
        code: 500,
        message: "Scraping failed",
        error: error.message
      });
    }
  }
);

// 404 handler for undefined routes
app.use((req, res) => {
  res.status(404).json({
    status: "error",
    code: 404,
    message: `Route ${req.method} ${req.path} not found`
  });
});

app.use(errorHandler);

// ==================== SERVER STARTUP ====================

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log("=".repeat(50));
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log("=".repeat(50));
  });

  server.timeout = SERVER_TIMEOUT;
  server.keepAliveTimeout = SERVER_TIMEOUT;
  server.headersTimeout = SERVER_TIMEOUT + 1000;

  // Graceful shutdown
  process.on("SIGTERM", () => {
    console.log("\n[SHUTDOWN] SIGTERM signal received: closing HTTP server");
    server.close(() => {
      console.log("[SHUTDOWN] HTTP server closed");
      process.exit(0);
    });
  });

  process.on("SIGINT", () => {
    console.log("\n[SHUTDOWN] SIGINT signal received: closing HTTP server");
    server.close(() => {
      console.log("[SHUTDOWN] HTTP server closed");
      process.exit(0);
    });
  });
}

module.exports = app;