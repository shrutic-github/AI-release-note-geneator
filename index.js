import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' })); // Increased limit for large diffs

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// 1. Get tags
app.get("/tags", async (req, res) => {
  let { repo } = req.query;

  // Extract owner/repo from full GitHub URL if provided
  if (repo.startsWith("http")) {
    try {
      const parts = new URL(repo).pathname.split("/").filter(Boolean);
      repo = `${parts[0]}/${parts[1]}`;
    } catch {
      return res.status(400).json({ error: "Invalid repo URL" });
    }
  }

  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/tags`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    });

    const tags = await resp.json();

    if (!Array.isArray(tags)) {
      return res.status(resp.status).json({
        error: tags.message || "Unexpected response from GitHub",
        details: tags
      });
    }

    res.json(tags.map(t => t.name));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch tags", details: err.message });
  }
});

// Helper function to get file content at specific commit
async function getFileContent(repo, filePath, sha) {
  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}?ref=${sha}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    });

    if (resp.status === 200) {
      const data = await resp.json();
      if (data.content && data.encoding === 'base64') {
        return Buffer.from(data.content, 'base64').toString('utf8');
      }
    }
    return null;
  } catch (err) {
    console.log(`Error fetching file content for ${filePath}:`, err.message);
    return null;
  }
}

// Helper function to truncate large patches for AI analysis
function truncatePatch(patch, maxLines = 50) {
  if (!patch) return null;

  const lines = patch.split('\n');
  if (lines.length <= maxLines) return patch;

  return lines.slice(0, maxLines).join('\n') + '\n... (truncated)';
}

// Helper function to process file changes and get content
async function processFileChanges(repo, files, baseCommit, headCommit) {
  const processedFiles = [];

  for (const file of files) {
    const fileInfo = {
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch: file.patch || null,
      previousFilename: file.previous_filename || null,
      blobUrl: file.blob_url,
      rawUrl: file.raw_url,
      sha: file.sha
    };

    // Get file content for both versions if the file exists (only for small files)
    const isLargeFile = file.changes > 1000 || (file.patch && file.patch.length > 100000);

    if (!isLargeFile) {
      if (file.status !== 'removed') {
        fileInfo.headContent = await getFileContent(repo, file.filename, headCommit);
      }

      if (file.status !== 'added') {
        const filename = file.previous_filename || file.filename;
        fileInfo.baseContent = await getFileContent(repo, filename, baseCommit);
      }
    }

    processedFiles.push(fileInfo);
  }

  return processedFiles;
}

// 2. Compare and run AI
app.post("/compare", async (req, res) => {
  let { repo, base, head } = req.body;

  // Extract owner/repo if full URL provided
  if (repo.startsWith("http")) {
    try {
      const parts = new URL(repo).pathname.split("/").filter(Boolean);
      repo = `${parts[0]}/${parts[1]}`;
    } catch {
      return res.status(400).json({ error: "Invalid repo URL" });
    }
  }

  try {
    console.log(`Comparing ${repo}: ${base}...${head}`);

    // Fetch diff with more details
    const diffResp = await fetch(`https://api.github.com/repos/${repo}/compare/${base}...${head}`, {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3.diff'
      }
    });

    // Get JSON format for structured data
    const diffRespJson = await fetch(`https://api.github.com/repos/${repo}/compare/${base}...${head}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    });

    const diffData = await diffRespJson.json();
    if (diffRespJson.status !== 200) {
      return res.status(diffRespJson.status).json({ error: diffData.message, details: diffData });
    }

    console.log(`Found ${diffData.files?.length || 0} files changed`);

    // Process files with content
    const processedFiles = await processFileChanges(repo, diffData.files || [], diffData.base_commit?.sha, diffData.merge_base_commit?.sha);

    // Fetch release notes
    const relResp = await fetch(`https://api.github.com/repos/${repo}/releases`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    });
    const releases = await relResp.json();
    const notes = Array.isArray(releases) ? releases.map(r => r.body || "").join("\n") : "";

    // Create summary for AI analysis (truncated for token limits)
    const filesSummary = processedFiles.map(file => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch: truncatePatch(file.patch, 30) // Limit patch size for AI
    })).slice(0, 20); // Limit number of files for AI analysis

    let aiAnalysis = [];

    // Only run AI analysis if we have a valid API key and files to analyze
    if (GEMINI_API_KEY && filesSummary.length > 0) {
      try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
        const prompt = `
          You are a senior software engineer. Analyze the following GitHub diff and release notes. 
          For each file changed:

          1. Explain exactly what was changed in the code (functions, logic, APIs, variables, etc).
          2. Describe the reason or potential purpose of the change (e.g. bug fix, performance improvement, feature addition).
          3. Indicate if this change is already mentioned in release notes.
          4. Rate significance: 
            - high (security, breaking change, major feature)
            - medium (bug fix, performance improvement, minor feature)
            - low (comments, refactor, small tweaks)

          Release Notes (truncated if too long):
          ${notes.substring(0, 2000)} ${notes.length > 2000 ? '...(truncated)' : ''}

          Files Changed (diff summary + patches):
          ${JSON.stringify(filesSummary, null, 2)}

          Respond ONLY with valid JSON array in this format:

          [
            {
              "filename": "exact_filename_from_input",
              "change_summary": "Detailed explanation of code changes and why they were made",
              "documented": true/false,
              "significance": "high/medium/low",
              "related_notes": "Release note snippet if matched, otherwise empty string"
            }
          ]`;

        const result = await model.generateContent(prompt);
        const aiOutput = result.response.text();

        let cleanedOutput = aiOutput.trim();
        if (cleanedOutput.startsWith("```")) {
          cleanedOutput = cleanedOutput.replace(/^```(?:json)?\n/, "").replace(/```$/, "");
        }

        try {
          aiAnalysis = JSON.parse(cleanedOutput);
        } catch (parseErr) {
          console.error("AI JSON parse error:", parseErr.message);
          aiAnalysis = [];
        }
      } catch (aiErr) {
        console.error("AI analysis error:", aiErr.message);
        aiAnalysis = [];
      }
    }

    // Combine file data with AI analysis
    const enhancedFiles = processedFiles.map(file => {
      const analysis = aiAnalysis.find(a => a.filename === file.filename) || {
        change_summary: "Analysis not available",
        documented: false,
        significance: "unknown",
        related_notes: ""
      };

      return {
        ...file,
        ai_analysis: analysis
      };
    });

    // Prepare response
    const response = {
      comparison: {
        base_commit: diffData.base_commit,
        head_commit: diffData.merge_base_commit,
        ahead_by: diffData.ahead_by,
        behind_by: diffData.behind_by,
        total_commits: diffData.total_commits,
        status: diffData.status,
        permalink_url: diffData.permalink_url,
        diff_url: diffData.diff_url
      },
      files: enhancedFiles,
      release_notes: notes,
      ai_analysis: aiAnalysis,
      summary: {
        total_files_changed: processedFiles.length,
        total_additions: processedFiles.reduce((sum, file) => sum + (file.additions || 0), 0),
        total_deletions: processedFiles.reduce((sum, file) => sum + (file.deletions || 0), 0),
        files_by_status: {
          added: processedFiles.filter(f => f.status === 'added').length,
          modified: processedFiles.filter(f => f.status === 'modified').length,
          removed: processedFiles.filter(f => f.status === 'removed').length,
          renamed: processedFiles.filter(f => f.status === 'renamed').length
        }
      }
    };

    res.json(response);

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({
      error: "Internal server error",
      details: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    env: {
      hasGithubToken: !!GITHUB_TOKEN,
      hasGeminiKey: !!GEMINI_API_KEY
    }
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Environment check:`);
  console.log(`- GitHub Token: ${GITHUB_TOKEN ? '✓ Present' : '✗ Missing'}`);
  console.log(`- Gemini API Key: ${GEMINI_API_KEY ? '✓ Present' : '✗ Missing'}`);
});