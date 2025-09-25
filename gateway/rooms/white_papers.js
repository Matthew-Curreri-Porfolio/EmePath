//Creates white papers marked up for training from digesting markdown files 
//in the white_papers directory. creates if doesnot exist
//updates if the file has been edited since last update
//deletes if the file has been deleted

import fs from 'fs';
import path from 'path';
import { getFileHash } from '../utils/fileHash.js';
import { loadMarkdownFile } from '../utils/markdownLoader.js';
import { saveWhitePaper, getWhitePaperByPath, deleteWhitePaperByPath } from '../models/whitePaper.js';

const WHITE_PAPERS_DIR = path.join(process.cwd(), 'gateway', 'rooms', 'white_papers');

async function processWhitePapers() {
    const files = fs.readdirSync(WHITE_PAPERS_DIR).filter(file => file.endsWith('.md'));
    
    // Track existing white papers to identify deletions
    const existingWhitePapers = new Set((await getAllWhitePapers()).map(wp => wp.filePath));

    for (const file of files) {
        const filePath = path.join(WHITE_PAPERS_DIR, file);
        const fileHash = await getFileHash(filePath);
        const existingPaper = await getWhitePaperByPath(filePath);
        
        if (existingPaper) {
            existingWhitePapers.delete(filePath);
            if (existingPaper.fileHash === fileHash) {
                console.log(`No changes in ${file}, skipping.`);
                continue; // No changes, skip processing
            }
        }
        
        const content = await loadMarkdownFile(filePath);
        const whitePaperData = {
            title: content.title || path.basename(file, '.md'),
            body: content.body,
            filePath,
            fileHash,
            updatedAt: new Date()
        };
        await saveWhitePaper(whitePaperData);
        console.log(`Processed white paper: ${file}`);
    }
    
    // Delete white papers that no longer exist
    for (const filePath of existingWhitePapers) {
        await deleteWhitePaperByPath(filePath);
        console.log(`Deleted white paper for removed file: ${filePath}`);
    }
}

async function getAllWhitePapers() {
    // Placeholder function to fetch all white papers from the database
    // Implement this function based on your database schema
    return [];
}

// Run the processing function
processWhitePapers().catch(err => {
    console.error('Error processing white papers:', err);
});
