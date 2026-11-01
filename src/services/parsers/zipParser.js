const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');

/**
 * Extracts a ZIP archive and indexes all contained files by type and directory structure.
 */
function extractZip(filePath, targetDir) {
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const zip = new AdmZip(filePath);
    zip.extractAllTo(targetDir, true);

    const results = {
        spreadsheets: [],
        documents: [],
        pdfs: [],
        images: [],
        allFiles: []
    };

    function traverse(currentDir) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                traverse(fullPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                const relPath = path.relative(targetDir, fullPath);
                const fileInfo = {
                    fullPath,
                    relPath,
                    filename: entry.name,
                    folderName: path.dirname(relPath) === '.' ? '' : path.dirname(relPath),
                    ext
                };

                results.allFiles.push(fileInfo);

                if (['.xlsx', '.xls', '.csv'].includes(ext)) {
                    results.spreadsheets.push(fileInfo);
                } else if (['.docx', '.doc'].includes(ext)) {
                    results.documents.push(fileInfo);
                } else if (ext === '.pdf') {
                    results.pdfs.push(fileInfo);
                } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
                    results.images.push(fileInfo);
                }
            }
        }
    }

    traverse(targetDir);
    return results;
}

module.exports = {
    extractZip
};
