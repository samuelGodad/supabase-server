"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const cors_1 = __importDefault(require("cors"));
const openai_1 = __importDefault(require("openai"));
const dotenv = __importStar(require("dotenv"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const pdf_poppler_1 = __importDefault(require("pdf-poppler"));
dotenv.config();
const app = (0, express_1.default)();
const upload = (0, multer_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const openai = new openai_1.default({
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
function tryParseJSON(text) {
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
    }
    catch (err) {
        return { success: false, error: 'Failed to parse response as JSON' };
    }
}
function convertPdfToImages(pdfBuffer) {
    return __awaiter(this, void 0, void 0, function* () {
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
            yield pdf_poppler_1.default.convert(pdfPath, opts);
            // Read all generated PNG files
            const files = fs.readdirSync(outputDir);
            const base64Images = [];
            for (const file of files) {
                if (file.endsWith('.png')) {
                    const imagePath = path.join(outputDir, file);
                    const imageBuffer = fs.readFileSync(imagePath);
                    const base64Image = imageBuffer.toString('base64');
                    base64Images.push(`data:image/png;base64,${base64Image}`);
                }
            }
            return base64Images;
        }
        finally {
            // Clean up temporary files
            if (fs.existsSync(pdfPath))
                fs.unlinkSync(pdfPath);
            if (fs.existsSync(outputDir)) {
                const files = fs.readdirSync(outputDir);
                for (const file of files) {
                    fs.unlinkSync(path.join(outputDir, file));
                }
                fs.rmdirSync(outputDir);
            }
        }
    });
}
app.post('/api/parse-pdf', upload.single('file'), (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
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
            const base64Images = yield convertPdfToImages(req.file.buffer);
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
            const allResults = [];
            for (let i = 0; i < base64Images.length; i++) {
                console.log(`\n=== Processing page ${i + 1}/${base64Images.length} ===`);
                const base64Image = base64Images[i];
                try {
                    console.log('Sending request to GPT-4 Vision API...');
                    const completion = yield openai.chat.completions.create({
                        model: 'gpt-4o', // Fixed model name
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
                    const responseText = ((_a = completion.choices[0].message) === null || _a === void 0 ? void 0 : _a.content) || '[]';
                    console.log(responseText);
                    console.log('------------------------');
                    const parseResult = tryParseJSON(responseText);
                    if (parseResult.success) {
                        console.log(`\nSuccessfully parsed ${parseResult.data.length} test results from page ${i + 1}`);
                        console.log('Parsed Results:', JSON.stringify(parseResult.data, null, 2));
                        allResults.push(...parseResult.data);
                    }
                    else {
                        console.error(`\nFailed to parse JSON from page ${i + 1}:`, parseResult.error);
                        console.error('Raw response:', responseText);
                    }
                }
                catch (pageError) {
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
        }
        catch (err) {
            console.error('\nOpenAI API Error:', err);
            throw err;
        }
    }
    catch (err) {
        console.error('\nError:', err);
        const errorMessage = err instanceof Error ? err.message : 'Failed to process PDF';
        res.status(500).json({
            success: false,
            error: errorMessage,
            details: err instanceof Error ? err.stack : undefined
        });
    }
}));
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
