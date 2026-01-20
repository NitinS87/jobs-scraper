const express = require("express");
const scrapeExternalJobLinks = require("./scraper");

const app = express();
const PORT = 3000;

// Default home route
app.get("/", (req, res) => {
  res.send(
    "<h2>Welcome to Job Scraper API</h2>" +
    "<p>Use <code>/scrape-jobs</code> to start scraping and <code>/jobs</code> to view results.</p>"
  );
});

// Route to start scraping
app.get("/scrape-jobs", async (req, res) => {
  try {
    res.status(202).json({ message: "Scraping started. Please wait..." });

    const links = await scrapeExternalJobLinks();
    console.log("Scraping completed");
    console.log(links);
  } catch (error) {
    console.error(error);
  }
});

// Route to get saved scraped jobs
app.get("/jobs", (req, res) => {
  try {
    const data = require("./external_job_links.json");
    res.json({ total: data.length, links: data });
  } catch (err) {
    res.status(500).json({ error: "No data found" });
  }
});

// Catch-all for wrong routes
app.use((req, res) => {
  res.status(404).json({ error: "Route not found. Check your URL!" });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
