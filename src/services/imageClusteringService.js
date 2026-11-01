const path = require('path');
const { hammingDistance } = require('./parsers/imageParser');

/**
 * Normalizes a filename to identify the core product name token.
 * E.g., 'valencia_orange_1.jpg' -> 'valencia orange'
 * 'EG-CIT-01-carton.png' -> 'eg cit 01'
 */
function getProductClusterKey(filename, folderName = '') {
    if (folderName && folderName !== '.' && folderName !== 'original' && folderName.length > 2) {
        return folderName.toLowerCase().replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, ' ').trim();
    }

    const ext = path.extname(filename);
    const base = path.basename(filename, ext)
        .toLowerCase()
        // Remove trailing numbers, copy markers, angle indicators (front, back, thumb, 1, 2, _01)
        .replace(/([_-]?(front|back|side|detail|pack|box|carton|thumb|main|hero|[0-9]+))+$/i, '')
        .replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return base || 'product';
}

/**
 * Groups an array of parsed image objects into product clusters.
 * Detects visual duplicates using perceptual hashes.
 * @param {Array<Object>} parsedImages - Output of parseImage()
 */
function clusterImages(parsedImages) {
    const clusters = {};
    const duplicateFlags = [];

    // 1. Detect visual duplicate pairs within the batch
    for (let i = 0; i < parsedImages.length; i++) {
        for (let j = i + 1; j < parsedImages.length; j++) {
            const imgA = parsedImages[i];
            const imgB = parsedImages[j];
            if (imgA.dhash && imgB.dhash) {
                const dist = hammingDistance(imgA.dhash, imgB.dhash);
                if (dist <= 5) {
                    duplicateFlags.push({
                        imageA: imgA.filename,
                        imageB: imgB.filename,
                        hammingDistance: dist,
                        warning: `الصورة (${imgB.filename}) مطابقة أو قريبة الشبه جداً بالصورة (${imgA.filename})`
                    });
                }
            }
        }
    }

    // 2. Group into clusters based on product key
    parsedImages.forEach((img, idx) => {
        const key = getProductClusterKey(img.filename, img.folderName);
        if (!clusters[key]) {
            clusters[key] = {
                cluster_key: key,
                suggested_title: img.suggested_title || key,
                images: []
            };
        }

        const isPrimaryKeyword = /main|hero|front|رئيسي|1\b/i.test(img.filename);
        const isFirst = clusters[key].images.length === 0;

        clusters[key].images.push({
            url: img.web_url,
            thumbnail_url: img.thumbnail_url,
            filename: img.filename,
            is_primary: isPrimaryKeyword || isFirst,
            display_order: clusters[key].images.length + 1,
            dhash: img.dhash,
            width: img.width,
            height: img.height
        });
    });

    // Ensure exactly one primary image per cluster
    Object.values(clusters).forEach(cluster => {
        const primaries = cluster.images.filter(img => img.is_primary);
        if (primaries.length > 1) {
            // Leave only the first marked as primary
            primaries.slice(1).forEach(img => { img.is_primary = false; });
        } else if (primaries.length === 0 && cluster.images.length > 0) {
            cluster.images[0].is_primary = true;
        }
    });

    return {
        clusters: Object.values(clusters),
        duplicate_warnings: duplicateFlags
    };
}

module.exports = {
    clusterImages,
    getProductClusterKey
};
