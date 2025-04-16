import express from 'express';
import multer from 'multer';
import cors from 'cors';
import OpenAI from 'openai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createCanvas } from 'canvas';
import pdfParse from 'pdf-parse';
import { mkdir, unlink } from 'fs/promises';

const execAsync = promisify(exec);

dotenv.config();

const app = express();
const upload = multer();

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = `You are a medical lab report parser. Your task is to extract lab test results from PDF documents.
You must analyze the content and identify:
- Test names
- Test categories (e.g., Hormones, Lipids, etc.)
- Numerical values and units
- Reference ranges
- Whether results are normal, high, or low based on the reference ranges
- Test dates

You must respond with ONLY a JSON array in the specified format, with no additional text.`;

const USER_PROMPT = `Please analyze this lab report and extract all test results.
For each test result found, include:
1. The exact test name as shown
2. The appropriate category for the test
3. The numerical value and unit
4. The reference range exactly as shown
5. Whether the result is normal, high, or low
6. The test date if available (use the report date if individual test dates aren't shown)

Return the data in this exact JSON format:
[
  {
    "test": "Test Name",
    "category": "Test Category",
    "result": "Numerical Value",
    "reference_min": "Minimum Reference Value",
    "reference_max": "Maximum Reference Value",
    "payor_code": "Payor Code",
    "status": "normal/high/low",
    "test_date": "YYYY-MM-DD"
  }
]

Important:
- Include ALL test results found in the document
- Use EXACTLY the format shown
- Return ONLY the JSON array, no other text
- Determine status based on whether the value is within, above, or below the reference range`;

function tryParseJSON(text: string): { success: boolean; data?: any; error?: string } {
  try {
    // Remove any non-JSON content before the first [
    const jsonStart = text.indexOf('[');
    if (jsonStart === -1) {
      return { success: false, error: 'No JSON array found in response' };
    }
    const jsonEnd = text.lastIndexOf(']') + 1;
    const jsonString = text.slice(jsonStart, jsonEnd);
    const data = JSON.parse(jsonString);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: 'Failed to parse response as JSON' };
  }
}

async function convertPdfToImages(pdfBuffer: Buffer): Promise<string[]> {
  const imagePaths: string[] = [];
  const tempDir = path.join(__dirname, 'temp');
  
  try {
    // Create temp directory if it doesn't exist
    await mkdir(tempDir, { recursive: true });

    // Load PDF document
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const numPages = pdfDoc.getPageCount();

    // Extract text content using pdf-parse
    const pdfData = await pdfParse(pdfBuffer);
    const pages = pdfData.text.split('\f'); // Split by form feed character

    for (let i = 0; i < numPages; i++) {
      const page = pdfDoc.getPage(i);
      const { width, height } = page.getSize();
      
      // Create a canvas with the same dimensions as the PDF page
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');

      // Set white background
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, width, height);

      // Set text properties
      ctx.fillStyle = 'black';
      ctx.font = '12px Arial';
      ctx.textBaseline = 'top';

      // Get text content for this page
      const pageText = pages[i] || '';
      
      // Split text into lines and draw them
      const lines = pageText.split('\n');
      const lineHeight = 20;
      const margin = 40;

      lines.forEach((line: string, index: number) => {
        const y = margin + (index * lineHeight);
        if (y < height - margin) {
          ctx.fillText(line, margin, y);
        }
      });

      // Convert canvas to buffer
      const imageBuffer = canvas.toBuffer('image/png');

      // Process image with sharp
      const processedBuffer = await sharp(imageBuffer)
        .resize(800, null, { fit: 'inside' })
        .toBuffer();

      // Save the processed image
      const imagePath = path.join(tempDir, `page_${i + 1}.png`);
      await fs.promises.writeFile(imagePath, processedBuffer);
      imagePaths.push(imagePath);
    }

    return imagePaths;
  } catch (error) {
    // Clean up any created files on error
    for (const imagePath of imagePaths) {
      try {
        await unlink(imagePath);
      } catch (e) {
        console.error('Error cleaning up file:', e);
      }
    }
    throw error;
  }
}

app.post('/api/parse-pdf', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      console.error('No file uploaded');
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log('\n=== Starting PDF Processing ===');
    console.log('Received file:', {
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size + ' bytes',
      bufferLength: req.file.buffer.length + ' bytes'
    });

    // Validate file size (PDFs should be at least 1KB)
    if (req.file.size < 1024) {
      console.error('File too small to be a valid PDF');
      return res.status(400).json({ 
        error: 'File too small to be a valid PDF',
        details: {
          size: req.file.size,
          minimumSize: 1024,
          message: 'PDF files should be at least 1KB in size'
        }
      });
    }

    // Validate PDF magic number (first 4 bytes should be "%PDF")
    const magicNumber = req.file.buffer.slice(0, 4).toString('ascii');
    console.log('PDF magic number:', magicNumber);
    
    if (magicNumber !== '%PDF') {
      console.error('Invalid PDF file format');
      return res.status(400).json({ 
        error: 'Invalid PDF file format',
        details: {
          magicNumber,
          expectedMagicNumber: '%PDF',
          message: 'The file does not appear to be a valid PDF'
        }
      });
    }

    try {
      // Convert PDF to images
      console.log('\nConverting PDF to images...');
      const imagePaths = await convertPdfToImages(req.file.buffer);
      console.log(`Successfully converted PDF to ${imagePaths.length} images`);

      if (imagePaths.length === 0) {
        console.error('No images were generated from the PDF');
        return res.status(400).json({ 
          error: 'Failed to convert PDF to images',
          details: {
            message: 'The PDF could not be converted to images. Please ensure it is a valid PDF file.'
          }
        });
      }

      // Process each page with GPT-4 Vision
      const allResults: any[] = [];
      
      for (let i = 0; i < imagePaths.length; i++) {
        console.log(`\n=== Processing page ${i + 1}/${imagePaths.length} ===`);
        const imagePath = imagePaths[i];
        try {
          console.log('Sending request to GPT-4 Vision API...');
          const completion = await openai.chat.completions.create({
            model: 'gpt-4o',  // Fixed model name
            messages: [
              {
                role: 'system',
                content: SYSTEM_PROMPT
              },
              {
                role: 'user',
                content: [
                  { type: 'text', text: USER_PROMPT },
                  {
                    type: 'image_url',
                    image_url: {
                      url: imagePath,
                    }
                  }
                ]
              }
            ],
            max_tokens: 4096
          });

          console.log('\nGPT-4 Vision Response:');
          console.log('------------------------');
          const responseText = completion.choices[0].message?.content || '[]';
          console.log(responseText);
          console.log('------------------------');

          const parseResult = tryParseJSON(responseText);
          if (parseResult.success) {
            console.log(`\nSuccessfully parsed ${parseResult.data.length} test results from page ${i + 1}`);
            console.log('Parsed Results:', JSON.stringify(parseResult.data, null, 2));
            allResults.push(...parseResult.data);
          } else {
            console.error(`\nFailed to parse JSON from page ${i + 1}:`, parseResult.error);
            console.error('Raw response:', responseText);
          }
        } catch (pageError) {
          console.error(`\nError processing page ${i + 1}:`, pageError);
          // Continue with other pages even if one fails
        }
      }

      console.log('\n=== Processing Complete ===');
      console.log(`Total test results extracted: ${allResults.length}`);
      console.log('All Results:', JSON.stringify(allResults, null, 2));

      // Combine results from all pages
      res.json({ 
        success: true,
        data: allResults,
        debug: {
          fileInfo: {
            size: req.file.size,
            pages: imagePaths.length,
            totalResults: allResults.length
          }
        }
      });
    } catch (err) {
      console.error('\nOpenAI API Error:', err);
      throw err;
    }
  } catch (err) {
    console.error('\nError:', err);
    const errorMessage = err instanceof Error ? err.message : 'Failed to process PDF';
    res.status(500).json({ 
      success: false,
      error: errorMessage,
      details: err instanceof Error ? err.stack : undefined
    });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 