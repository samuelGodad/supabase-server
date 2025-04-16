import express from 'express';
import multer from 'multer';
import cors from 'cors';
import OpenAI from 'openai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import pdf from 'pdf-poppler';

dotenv.config();

const app = express();
const upload = multer();

app.use(cors());
app.use(express.json());

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
  const tempDir = os.tmpdir();
  const pdfPath = path.join(tempDir, `temp_${Date.now()}.pdf`);
  const outputDir = path.join(tempDir, `output_${Date.now()}`);
  
  // Write PDF to temporary file
  fs.writeFileSync(pdfPath, pdfBuffer);
  
  // Create output directory
  fs.mkdirSync(outputDir, { recursive: true });
  
  try {
    // Convert PDF to images using pdf-poppler
    const opts = {
      format: 'png',
      out_dir: outputDir,
      out_prefix: 'page',
      page: null // convert all pages
    };
    
    await pdf.convert(pdfPath, opts);
    
    // Read all generated PNG files
    const files = fs.readdirSync(outputDir);
    const base64Images: string[] = [];
    
    for (const file of files) {
      if (file.endsWith('.png')) {
        const imagePath = path.join(outputDir, file);
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');
        base64Images.push(`data:image/png;base64,${base64Image}`);
      }
    }
    
    return base64Images;
  } finally {
    // Clean up temporary files
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir);
      for (const file of files) {
        fs.unlinkSync(path.join(outputDir, file));
      }
      fs.rmdirSync(outputDir);
    }
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
      const base64Images = await convertPdfToImages(req.file.buffer);
      console.log(`Successfully converted PDF to ${base64Images.length} images`);

      if (base64Images.length === 0) {
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
      
      for (let i = 0; i < base64Images.length; i++) {
        console.log(`\n=== Processing page ${i + 1}/${base64Images.length} ===`);
        const base64Image = base64Images[i];
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
                      url: base64Image,
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
            pages: base64Images.length,
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
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 