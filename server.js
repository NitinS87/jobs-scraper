const express = require("express");
const scrapeJobs = require("./scraper");

const app = express();
const PORT = 3000;

app.use(express.json());

app.post("/scrape-jobs", async (req, res) => {
  try {
    const jobs = await scrapeJobs();

    return res.status(200).json({
      status: "success",
      code: 200,
      count: jobs.length,
      data: jobs
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      status: "error",
      code: 500,
      message: "Scraping failed",
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
