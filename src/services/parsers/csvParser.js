const xlsx = require('xlsx');
const { parseExcel } = require('./excelParser');

/**
 * Parses a CSV file using sheetJS parser to preserve character encodings (UTF-8, Arabic).
 */
function parseCsv(filePath) {
    return parseExcel(filePath);
}

module.exports = {
    parseCsv
};
