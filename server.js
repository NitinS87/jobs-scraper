const express = require("express");
const naukrigulfJobsScraper = require("./NaukriGulf-Scraper");

const app = express();
const PORT = 3000;

app.use(express.json());

app.post("/naukri-gulf", async (req, res) => {
  try {
    const jobs = await naukrigulfJobsScraper();

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
