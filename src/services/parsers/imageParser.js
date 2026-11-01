const { Jimp } = require('jimp');
const path = require('path');
const fs = require('fs');
const config = require('../../config');

/**
 * Computes difference hash (dHash) for an image buffer/instance.
 * Resizes to 9x8, converts to grayscale, and compares adjacent pixels.
 */
async function computeDHash(image) {
    try {
        const clone = image.clone();
        clone.resize({ w: 9, h: 8 });
        clone.greyscale();

        let hashBits = '';
        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                // In Jimp, getPixelColor returns an int32
                const left = clone.getPixelColor(x, y);
                const right = clone.getPixelColor(x + 1, y);
                hashBits += left > right ? '1' : '0';
            }
        }
        // Convert 64 bits to 16 hex characters
        let hex = '';
        for (let i = 0; i < hashBits.length; i += 4) {
            hex += parseInt(hashBits.substr(i, 4), 2).toString(16);
        }
        return hex;
    } catch (err) {
        return '0000000000000000';
    }
}

/**
 * Calculates Hamming distance between two 16-hex-character hashes.
 */
function hammingDistance(hash1, hash2) {
    if (!hash1 || !hash2 || hash1.length !== hash2.length) return 64;
    let distance = 0;
    for (let i = 0; i < hash1.length; i++) {
        let x = parseInt(hash1[i], 16) ^ parseInt(hash2[i], 16);
        while (x > 0) {
            distance += x & 1;
            x >>= 1;
        }
    }
    return distance;
}

/**
 * Inspects an image, creates a thumbnail, and extracts metadata.
 */
async function parseImage(filePath, relativeWebPath = '') {
    try {
        const stats = fs.statSync(filePath);
        const image = await Jimp.read(filePath);
        const width = image.bitmap.width;
        const height = image.bitmap.height;

        // Compute perceptual hash
        const dhash = await computeDHash(image);

        // Ensure thumbnails dir exists
        if (!fs.existsSync(config.THUMBNAILS_DIR)) {
            fs.mkdirSync(config.THUMBNAILS_DIR, { recursive: true });
        }

        const thumbFilename = 'thumb_' + path.basename(filePath);
        const thumbPath = path.join(config.THUMBNAILS_DIR, thumbFilename);

        const thumbImage = image.clone();
        thumbImage.resize({ w: 320, h: 240 });
        await thumbImage.write(thumbPath);

        const baseName = path.basename(filePath, path.extname(filePath))
            .replace(/[_-]+/g, ' ')
            .replace(/[0-9]+$/g, '')
            .trim();

        return {
            original_path: filePath,
            web_url: relativeWebPath || `/storage/uploads/${path.basename(path.dirname(path.dirname(filePath)))}/original/${path.basename(filePath)}`,
            thumbnail_url: `/storage/thumbnails/${thumbFilename}`,
            filename: path.basename(filePath),
            suggested_title: baseName,
            width,
            height,
            file_size: stats.size,
            dhash
        };
    } catch (err) {
        console.error('Error in parseImage:', err);
        return {
            original_path: filePath,
            web_url: relativeWebPath,
            thumbnail_url: null,
            filename: path.basename(filePath),
            suggested_title: path.basename(filePath, path.extname(filePath)),
            width: 0,
            height: 0,
            file_size: 0,
            dhash: null,
            error: err.message
        };
    }
}

module.exports = {
    parseImage,
    computeDHash,
    hammingDistance
};
