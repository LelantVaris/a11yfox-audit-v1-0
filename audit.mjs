import fs from 'fs';
import csv from 'csv-parser';
import { format } from 'fast-csv';
import puppeteer from 'puppeteer';
import { URL } from 'url';

const inputCsvFile = 'urls.csv';
const outputCsvFile = 'results.csv';
const maxRetries = 3;
const auditTimeout = 60000; // 60 seconds timeout for Lighthouse audit

(async () => {
  const urls = [];

  // Read URLs from the CSV file
  fs.createReadStream(inputCsvFile)
    .pipe(csv())
    .on('data', (row) => {
      if (row.url) {
        // Trim whitespace and ensure the URL has a scheme (http/https)
        let formattedUrl = row.url.trim();
        if (!/^https?:\/\//i.test(formattedUrl)) {
          formattedUrl = `http://${formattedUrl}`;
        }
        urls.push(formattedUrl);
      }
    })
    .on('end', async () => {
      console.log('CSV file successfully processed');

      // Initialize CSV writing
      const ws = fs.createWriteStream(outputCsvFile);
      const csvStream = format({ headers: true });
      csvStream.pipe(ws);

      for (const url of urls) {
        console.log(`Processing ${url}`);

        // Wait for 3 seconds before starting the audit
        await new Promise(resolve => setTimeout(resolve, 3000));

        let score;
        let metaTitle = '';
        let metaDescription = '';

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            console.log(`Attempt ${attempt} for ${url}`);
            ({ score, metaTitle, metaDescription } = await runLighthouseAudit(url));
            console.log(`Successfully processed ${url} with score: ${score}`);
            break; // Exit loop if audit is successful
          } catch (error) {
            console.error(`Attempt ${attempt} failed for ${url}: ${error.message}`);
            if (attempt === maxRetries || (attempt === 2 && error.message === 'Lighthouse audit timed out')) {
              console.error(`Max retries reached or audit timed out twice for ${url}. Skipping.`);
              score = 0;
              metaTitle = metaTitle || 'N/A';
              metaDescription = metaDescription || 'N/A';
              break;
            } else {
              await new Promise(resolve => setTimeout(resolve, 3000)); // Wait before retrying
            }
          }
        }

        csvStream.write({ url, score, metaTitle, metaDescription });
      }

      csvStream.end();
      console.log('Lighthouse audits completed and results saved to results.csv');
    });
})();

async function runLighthouseAudit(url) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    console.log(`Navigating to ${url}`);
    // Navigate to the page and wait until it's fully loaded, with a timeout
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log(`Extracting meta information from ${url}`);
    // Extract the meta title and meta description
    const metaTitle = await page.title();
    const metaDescription = await page.$eval('meta[name="description"]', element => element.content).catch(() => 'No meta description');

    console.log(`Running Lighthouse audit on ${url}`);
    // Dynamically import lighthouse
    const { default: lighthouse } = await import('lighthouse');

    const lighthousePromise = lighthouse(url, {
      port: (new URL(browser.wsEndpoint())).port,
      output: 'json',
      onlyCategories: ['accessibility']
    });

    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Lighthouse audit timed out')), auditTimeout));

    const { lhr } = await Promise.race([lighthousePromise, timeoutPromise]);

    return {
      score: lhr.categories.accessibility.score * 100, // Lighthouse scores are out of 100
      metaTitle,
      metaDescription
    };
  } catch (error) {
    console.error(`Error during processing ${url}: ${error.message}`);
    throw error; // Re-throw the error to handle retries
  } finally {
    await browser.close();
  }
}
