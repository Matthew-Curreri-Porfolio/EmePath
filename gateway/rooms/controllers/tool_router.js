//acts as middle ware to create a curl command for accessing the services end points using the gateway_useage.json
// to request dynamic usage via llm calls using a prompt generator that mixes the usage of said jsonfile

import express from 'express';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

const router = express.Router();
const USAGE_FILE = path.join(
  process.cwd(),
  'gateway',
  'rooms',
  'gateway_usage.json'
);

// Load usage data from JSON file
function loadUsageData() {
  if (!fs.existsSync(USAGE_FILE)) {
    throw new Error('Usage file not found');
  }
  const data = fs.readFileSync(USAGE_FILE, 'utf-8');
  return JSON.parse(data);
}

// Curl against the service end point for llm chat completion return the response
async function curlService(serviceUrl, prompt) {
  return new Promise((resolve, reject) => {
    const curlCommand = `curl -X POST ${serviceUrl} -H "Content-Type: application/json" -d '{"prompt": "${prompt}"}'`;
    exec(curlCommand, (error, stdout, stderr) => {
      if (error) {
        return reject(`Error: ${stderr}`);
      }
      resolve(stdout);
    });
  });
}
