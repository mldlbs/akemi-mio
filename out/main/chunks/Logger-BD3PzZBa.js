"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
let requestCounter = 0;
const BEIJING_OFFSET = 8 * 3600 * 1e3;
function beijingTimestamp() {
  return new Date(Date.now() + BEIJING_OFFSET).toISOString().replace("Z", "+08:00");
}
function beijingDateStr() {
  return new Date(Date.now() + BEIJING_OFFSET).toISOString().slice(0, 10);
}
let logDir = null;
let currentDateStr = "";
let stream = null;
let bytesWritten = 0;
let rotationCheckCounter = 0;
let projectStream = null;
let projectBytesWritten = 0;
const MAX_PROJECT_FILE_SIZE = 50 * 1024 * 1024;
let writeLock = Promise.resolve();
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ROTATION_CHECK_INTERVAL = 50;
const RETENTION_DAYS = 30;
function createRequestId() {
  requestCounter++;
  return `req_${String(Date.now()).slice(-6)}_${requestCounter}`;
}
function sanitizeForLog(text) {
  return text.replace(/\b(sk-[\w-]{10,})/g, (m) => m.slice(0, 8) + "***" + m.slice(-4));
}
function getDailyLogPath(baseDir, dateStr) {
  return path.join(baseDir, `app-${dateStr}.log`);
}
function ensureStream() {
  if (!logDir) return;
  const dateStr = beijingDateStr();
  if (stream && dateStr === currentDateStr && bytesWritten < MAX_FILE_SIZE) {
    return;
  }
  if (stream) {
    try {
      stream.end();
    } catch {
    }
    stream = null;
  }
  currentDateStr = dateStr;
  const filePath = getDailyLogPath(logDir, dateStr);
  try {
    const existingSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    bytesWritten = existingSize;
    if (existingSize >= MAX_FILE_SIZE) {
      let n = 1;
      let rotatedPath;
      do {
        rotatedPath = getDailyLogPath(logDir, `${dateStr}.${n}`);
        n++;
      } while (fs.existsSync(rotatedPath));
      try {
        fs.renameSync(filePath, rotatedPath);
        bytesWritten = 0;
      } catch {
      }
    }
    stream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf-8" });
    stream.on("error", () => {
      stream = null;
    });
  } catch {
    stream = null;
  }
}
function cleanupOldLogs() {
  if (!logDir) return;
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1e3;
    const files = fs.readdirSync(logDir);
    for (const file of files) {
      if (!file.startsWith("app-") || !file.endsWith(".log")) continue;
      const filePath = path.join(logDir, file);
      try {
        const mtime = fs.statSync(filePath).mtimeMs;
        if (mtime < cutoff) {
          fs.unlinkSync(filePath);
        }
      } catch {
      }
    }
  } catch {
  }
}
const FEEDBACK_API = "https://skills.crlkcloud.cyou/feedback/api/feedback";
const SITE_ID = "akemi-mio";
let lastErrorReport = 0;
const ERROR_REPORT_INTERVAL = 6e4;
function reportError(entry) {
  const now = Date.now();
  const event = entry.event;
  if (now - lastErrorReport < ERROR_REPORT_INTERVAL) return;
  lastErrorReport = now;
  try {
    const body = JSON.stringify({
      site_id: SITE_ID,
      type: "bug",
      message: `[${entry.level}] ${event}
${JSON.stringify(entry, null, 2)}`
    });
    const req = https.request(
      FEEDBACK_API,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
        });
      }
    );
    req.on("error", () => {
    });
    req.write(body);
    req.end();
  } catch {
  }
}
function initLogFile(userDataPath) {
  logDir = path.join(userDataPath, "logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  ensureStream();
  cleanupOldLogs();
}
function getLogFilePath() {
  if (!logDir) return null;
  return getDailyLogPath(logDir, beijingDateStr());
}
function ensureProjectLog() {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const path$1 = path.join(projectRoot, "logs.txt");
  if (projectStream) {
    try {
      if (fs.existsSync(path$1) && fs.statSync(path$1).size >= MAX_PROJECT_FILE_SIZE) {
        projectStream.end();
        projectStream = null;
        let n = 1;
        let rotatedPath;
        do {
          rotatedPath = path.join(projectRoot, `logs.${n}.txt`);
          n++;
        } while (fs.existsSync(rotatedPath));
        try {
          fs.renameSync(path$1, rotatedPath);
        } catch {
        }
        projectBytesWritten = 0;
      }
    } catch {
      projectStream = null;
    }
    return;
  }
  try {
    projectBytesWritten = fs.existsSync(path$1) ? fs.statSync(path$1).size : 0;
    projectStream = fs.createWriteStream(path$1, { flags: "a", encoding: "utf-8" });
    projectStream.on("error", () => {
      projectStream = null;
    });
  } catch {
    projectStream = null;
  }
}
function log(level, event, meta) {
  const entry = {
    level,
    timestamp: beijingTimestamp(),
    event,
    ...meta || {}
  };
  const line = JSON.stringify(entry);
  console.log(line);
  writeLock = writeLock.then(() => {
    if (logDir) {
      ensureStream();
      if (stream) {
        try {
          stream.write(line + "\n");
          bytesWritten += line.length + 1;
          rotationCheckCounter++;
          if (rotationCheckCounter >= ROTATION_CHECK_INTERVAL) {
            rotationCheckCounter = 0;
            if (bytesWritten >= MAX_FILE_SIZE) {
              try {
                stream.end();
              } catch {
              }
              stream = null;
            }
            if (Math.random() < 0.02) cleanupOldLogs();
          }
        } catch {
        }
      }
    }
    ensureProjectLog();
    if (projectStream) {
      try {
        projectStream.write(line + "\n");
        projectBytesWritten += line.length + 1;
      } catch {
      }
    }
    if (level === "ERROR") reportError(entry);
  }).catch(() => {
  });
}
exports.createRequestId = createRequestId;
exports.getLogFilePath = getLogFilePath;
exports.initLogFile = initLogFile;
exports.log = log;
exports.sanitizeForLog = sanitizeForLog;
