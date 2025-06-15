import express from "express";
import multer from "multer";
import sharp from "sharp";
import cors from "cors";
import dotenv from "dotenv";
import { Request, Response } from "express";
import asyncHandler from "express-async-handler";
import morgan from "morgan";
import { spawn } from "child_process"; // Import spawn for running ffmpeg
import fs from "fs/promises"; // Import fs.promises for file operations
import path from "path"; // Import path for path manipulation
import { v4 as uuidv4 } from "uuid"; // Import uuid for unique filenames

// Load environment variables from .env file
dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Configure CORS for your frontend's origin
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// Add Morgan for request logging
app.use(morgan("dev"));

app.use(express.json());

// Configure Multer for memory storage.
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // Increased to 100MB per file to better handle videos
  },
  fileFilter: (req, file, cb) => {
    // Accept only image or video files based on MIME type
    if (
      file.mimetype.startsWith("image/") ||
      file.mimetype.startsWith("video/")
    ) {
      cb(null, true);
    } else {
      cb(null, true);
    }
  },
});

// Define the allowed output formats and their corresponding MIME types
const allowedImageFormats = new Map<string, string>([
  ["png", "image/png"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["webp", "image/webp"],
]);

const allowedVideoFormats = new Map<string, string>([
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
  // You can extend this with other video formats if your FFmpeg compilation supports them (e.g., 'avi', 'mov')
]);

// Image conversion endpoint
app.post(
  "/convert",
  upload.array("images"), // Expects files under the 'images' field from frontend
  asyncHandler(async (req: Request, res: Response) => {
    console.log(`[Request] POST /convert received.`);
    console.log(`[Request] Target Format: ${req.body.format}`);

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      console.log(`[Response] 400: No files uploaded.`);
      res.status(400).json({ error: "No files uploaded." });
      return;
    }
    console.log(`[Request] Image Files received: ${files.length}`);
    files.forEach((file, index) => {
      console.log(
        `[Request] File ${index + 1}: ${file.originalname}, MIME: ${
          file.mimetype
        }, Size: ${file.size} bytes`
      );
    });

    const targetFormat = req.body.format as string;

    if (!targetFormat || !allowedImageFormats.has(targetFormat.toLowerCase())) {
      console.log(`[Response] 400: Invalid or missing target image format.`);
      res.status(400).json({
        error:
          "Invalid or missing target image format. Supported formats: png, jpeg, webp.",
      });
      return;
    }

    const convertedResults = await Promise.all(
      files.map(async (file) => {
        try {
          const outputBuffer = await sharp(file.buffer)
            .toFormat(targetFormat.toLowerCase() as keyof sharp.FormatEnum)
            .toBuffer();

          const base64Image = outputBuffer.toString("base64");
          const originalBaseName = file.originalname
            .split(".")
            .slice(0, -1)
            .join(".");
          const newFileName = `${originalBaseName}.${targetFormat.toLowerCase()}`;

          console.log(
            `    [Conversion Success] ${file.originalname} converted to ${newFileName}`
          );
          return {
            originalName: file.originalname,
            newName: newFileName,
            mimeType: allowedImageFormats.get(targetFormat.toLowerCase())!,
            data: base64Image,
          };
        } catch (error: any) {
          console.error(
            `    [Conversion Error] Failed to process ${file.originalname}:`,
            error.message
          );
          return {
            originalName: file.originalname,
            newName: `${file.originalname}.error`,
            mimeType: "application/octet-stream", // Generic binary type for error
            data: "",
            error: `Failed to convert: ${error.message || "Unknown error"}`,
          };
        }
      })
    );

    console.log(
      `[Response] POST /convert sending ${convertedResults.length} converted image files.`
    );
    res.json({ success: true, convertedFiles: convertedResults });
  })
);

// REAL Video conversion endpoint with FFmpeg
app.post(
  "/convert-video",
  upload.array("videos"), // Expects files under the 'videos' field from frontend
  asyncHandler(async (req: Request, res: Response) => {
    console.log(`[Request] POST /convert-video received.`);
    console.log(`[Request] Target Format: ${req.body.format}`);

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      console.log(`[Response] 400: No video files uploaded.`);
      res.status(400).json({ error: "No video files uploaded." });
      return;
    }
    console.log(`[Request] Video Files received: ${files.length}`);
    files.forEach((file, index) => {
      console.log(
        `[Request] File ${index + 1}: ${file.originalname}, MIME: ${
          file.mimetype
        }, Size: ${file.size} bytes`
      );
    });

    const targetFormat = req.body.format as string;
    const targetMimeType = allowedVideoFormats.get(targetFormat.toLowerCase());

    if (!targetFormat || !targetMimeType) {
      console.log(`[Response] 400: Invalid or missing target video format.`);
      res.status(400).json({
        error:
          "Invalid or missing target video format. Supported formats: mp4, webm.",
      });
      return;
    }

    const convertedResults = await Promise.all(
      files.map(async (file) => {
        let inputFilePath: string | undefined;
        let outputFilePath: string | undefined;
        try {
          // 1. Generate unique filenames for input and output in the /tmp directory
          const uniqueId = uuidv4();
          const inputFileName = `${uniqueId}_input${path.extname(
            file.originalname
          )}`;
          const outputFileName = `${uniqueId}_output.${targetFormat.toLowerCase()}`;

          inputFilePath = path.join("/tmp", inputFileName);
          outputFilePath = path.join("/tmp", outputFileName);

          // 2. Save the uploaded video buffer to a temporary input file
          await fs.writeFile(inputFilePath, file.buffer);
          console.log(`    [FFmpeg] Saved input file to: ${inputFilePath}`);

          // 3. Construct the ffmpeg command arguments
          // -i: input file
          // -c:v: video codec (libx264 for MP4, libvpx for WebM)
          // -preset: encoding speed vs. compression ratio tradeoff. 'veryfast' is a good balance.
          // -crf: Constant Rate Factor (for H.264/VP9) - quality setting. Higher value = lower quality, smaller file.
          // -threads 0: tells FFmpeg to use all available CPU cores.
          // -y: overwrite output file if it exists without asking.
          const ffmpegArgs = [
            "-i",
            inputFilePath,
            "-c:v",
            targetFormat === "webm" ? "libvpx" : "libx264",
            "-preset",
            "veryfast", // Options: 'ultrafast', 'superfast', 'fast', 'medium', 'slow', 'slower', 'veryslow'
            "-crf",
            "28",
            "-threads",
            "0",
            "-y",
            outputFilePath,
          ];

          console.log(
            `    [FFmpeg] Running command: ffmpeg ${ffmpegArgs.join(" ")}`
          );

          // 4. Execute ffmpeg as a child process
          const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

          let ffmpegErrorOutput = ""; // Collect FFmpeg stderr for debugging
          ffmpegProcess.stderr.on("data", (data) => {
            ffmpegErrorOutput += data.toString();
          });

          await new Promise<void>((resolve, reject) => {
            ffmpegProcess.on("close", (code) => {
              if (code === 0) {
                console.log(
                  `    [FFmpeg] Conversion successful for ${file.originalname}`
                );
                resolve();
              } else {
                console.error(
                  `    [FFmpeg] Conversion failed for ${file.originalname} with code ${code}. FFmpeg Output: ${ffmpegErrorOutput}`
                );
                reject(
                  new Error(
                    `FFmpeg conversion failed: ${
                      ffmpegErrorOutput || "Unknown FFmpeg error"
                    }`
                  )
                );
              }
            });
            ffmpegProcess.on("error", (err) => {
              // Catches errors like 'ffmpeg not found'
              console.error(
                `    [FFmpeg] Failed to start FFmpeg process for ${file.originalname}:`,
                err.message
              );
              reject(new Error(`Failed to start FFmpeg: ${err.message}`));
            });
          });

          // 5. Get the file size for the newly converted video
          const convertedFileSize = (await fs.stat(outputFilePath)).size;

          // 6. Generate a temporary download URL pointing back to this Express server
          // IMPORTANT: For production, you would upload `outputFilePath` to a cloud storage
          // service (e.g., AWS S3, Google Cloud Storage) and return its public, secure, temporary URL.
          // Serving directly from /tmp is not scalable or robust for production traffic.
          const downloadUrl = `${req.protocol}://${req.get(
            "host"
          )}/download-video/${path.basename(outputFilePath)}`;

          console.log(
            `    [FFmpeg] Converted video stored temporarily at: ${outputFilePath}`
          );
          console.log(`    [FFmpeg] Download URL provided: ${downloadUrl}`);

          return {
            originalName: file.originalname,
            newName: path.basename(outputFilePath), // Send the new filename to frontend
            mimeType: targetMimeType,
            downloadUrl: downloadUrl,
            size: convertedFileSize,
          };
        } catch (error: any) {
          console.error(
            `    [Video Conversion Error] Failed to process ${file.originalname}:`,
            error.message
          );
          return {
            originalName: file.originalname,
            newName: `${file.originalname}.error`,
            mimeType: "application/octet-stream", // Generic binary type for error status
            downloadUrl: "#", // No download available on error
            error: `Failed to convert: ${error.message || "Unknown error"}`,
          };
        } finally {
          // IMPORTANT: Clean up the *input* file immediately to free up disk space.
          if (inputFilePath) {
            try {
              await fs.unlink(inputFilePath);
              console.log(`    [FFmpeg] Cleaned up input: ${inputFilePath}`);
            } catch (err) {
              console.error(`    [FFmpeg] Error cleaning input: ${err}`);
            }
          }
          // ! Do NOT delete outputFilePath here if you intend to serve it via /download-video immediately !
          // In a production setup, cleanup of output files would be managed by a separate background process
          // after they are downloaded or after a certain expiry time from cloud storage.
          console.log(
            `    [FFmpeg] Output file ${outputFilePath} retained in /tmp for demonstration download.`
          );
        }
      })
    );

    console.log(
      `[Response] POST /convert-video sending ${convertedResults.length} conversion results.`
    );
    res.json({
      success: true,
      message:
        "Video conversion completed. Download links point to temporary server files.",
      convertedFiles: convertedResults,
    });
  })
);

// Endpoint to serve converted video files from /tmp (for demonstration only)
// In a real production app, this would be replaced by direct links to cloud storage.
app.get(
  "/download-video/:filename",
  asyncHandler(async (req: Request, res: Response) => {
    const filename = req.params.filename;
    const filePath = path.join("/tmp", filename);

    try {
      await fs.access(filePath); // Check if file exists and is accessible

      // Determine MIME type for correct browser handling based on file extension
      let mimeType = "application/octet-stream"; // Default generic
      const ext = path.extname(filename).toLowerCase();
      if (ext === ".mp4") mimeType = "video/mp4";
      else if (ext === ".webm") mimeType = "video/webm";
      // Add more video/audio formats if supported and served

      res.setHeader("Content-Type", mimeType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      ); // Force download in browser

      res.download(filePath, filename, (err) => {
        if (err) {
          // Check if headers were already sent to prevent "Cannot set headers after they are sent to the client" error
          if (res.headersSent) {
            console.error(
              `[Download Error] Headers already sent for ${filename}, but error occurred during download:`,
              err.message
            );
          } else {
            console.error(
              `[Download Error] Failed to download ${filename}:`,
              err.message
            );
            res
              .status(404)
              .send(
                "File not found or no longer available. It might have been automatically cleaned up by the OS."
              );
          }
        } else {
          console.log(`[Download] Sent file: ${filename}`);
          // Optional: In a production setup, you might trigger cleanup of the *output* file here
          // after a successful download, or based on a timer/job.
          // For this demo, files remain in /tmp until container restart/OS cleanup.
        }
      });
    } catch (error: any) {
      console.error(
        `[Download Error] File access failed for ${filename}:`,
        error.message
      );
      res.status(404).send("File not found or not accessible.");
    }
  })
);

// Simple health check endpoint
app.get("/", (req: Request, res: Response) => {
  console.log(`[Request] GET / received.`);
  res.send("Hello Media Service! Image Converter Backend is operational.");
});

// Another endpoint example
app.get("/media/hello", (req: Request, res: Response) => {
  console.log(`[Request] GET /media/hello received.`);
  res.json({ message: "Welcome to the Media Service API!" });
});

// Start the server
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  console.log(
    `CORS allowed origin: ${
      process.env.FRONTEND_URL || "http://localhost:3000"
    }`
  );
});
