const pdf = require('pdf-parse');
const fs = require('fs');

/**
 * Parse payroll PDF and extract time entry data
 * Format: Each time entry is on a single line with fixed columns
 */
async function parsePayrollPDF(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdf(dataBuffer);

  const entries = [];
  const ignoredLines = [];
  const detectedTotals = [];
  const lines = data.text.split('\n');

  let currentEmployee = null;
  let currentUnionLocal = null;
  let currentDate = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (!line) continue;
    
    // Check for employee header line (has 4-digit number at start, then name, then date)
    // Example: "4086       Arthur E Stefanick Jr             10/24/23"
    const employeeMatch = line.match(/^(\d{4})\s+([A-Z][a-zA-Z\s\.'-]+?)\s+(\d{2}\/\d{2}\/\d{2})/);
    if (employeeMatch) {
      currentUnionLocal = employeeMatch[1];
      currentEmployee = employeeMatch[2].trim();
      currentDate = employeeMatch[3];
      continue;
    }
    
    // Check for standalone date line (appears between entries)
    // Example: "                                             11/07/23"
    const dateOnlyMatch = line.match(/^\s+(\d{2}\/\d{2}\/\d{2})\s*$/);
    if (dateOnlyMatch) {
      currentDate = dateOnlyMatch[1];
      continue;
    }
    
    // Capture reported totals for later reconciliation
    if (/total\s+hours/i.test(line) || /grand\s+totals?/i.test(line)) {
      const numberMatches = line.match(/([\d]+[\d.,]*)/g) || [];
      if (numberMatches.length) {
        // The first numeric column on these lines is the hours total; later numbers are dollar amounts
        const parsed = parseNumber(numberMatches[0]);
        if (parsed > 0) {
          detectedTotals.push(parsed);
        }
      }
    }

    // Check for time entry line - made more flexible
    // The key identifiers are: Pay Class (J/F/G/A1-A6), 3-digit pay ID, Cert Class, hours with decimal, rate with 5 decimals, cost code
    // Example: "      J   841       TA01J1       0                 2.50      31.68000           79.207552.  Cuy Fal Bld 1 1st Fl             09-170"
    // More flexible pattern that handles varying spacing and different "7552" vs "7572" endings
    // Cost code pattern updated to handle variable lengths: 1-2 digits, hyphen, 2-5 digits (e.g., "1-400", "09-170", "01-4000")
    // Certified class suffix can sometimes be a letter (e.g., "CA01AO") instead of a digit
    // Amount column can vary, so accept any numeric group instead of the previous fixed 75xx pattern
    const entryMatch = line.match(/^\s+([A-Z]\d?)\s+(\d{3})\s+([A-Z]{2}\d{2}[A-Z][A-Z0-9])\s+\S+\s+([\d.,]+)\s+([\d.,]+)\s+[\d.,]+\s+(.+?)\s+([\d]{1,2}-[\d]{2,5})/);

    // Fallback: same structure but missing/invalid cost code at the end
    const entryNoCodeMatch = !entryMatch && line.match(/^\s+([A-Z]\d?)\s+(\d{3})\s+([A-Z]{2}\d{2}[A-Z][A-Z0-9])\s+\S+\s+([\d.,]+)\s+([\d.,]+)\s+[\d.,]+\s+(.+)/);

    if ((entryMatch || entryNoCodeMatch) && currentEmployee && currentDate) {
      const parts = entryMatch || entryNoCodeMatch;
      const payClass = parts[1];
      const payId = parts[2];
      const certifiedClass = parts[3];
      const hoursRaw = parts[4];
      const hoursIsNegative = /-\s*$/.test(hoursRaw);
      const hours = hoursIsNegative ? 0 : parseNumber(hoursRaw);
      const rate = parseNumber(parts[5]);
      const jobDescription = (parts[6] || '').trim();
      const costCode = entryMatch ? parts[7] : null;

      if (hoursIsNegative) {
        ignoredLines.push(`${line.trim()} (ignored negative hours)`);
        continue;
      }

      entries.push({
        employee_name: currentEmployee,
        pay_id: payId,
        pay_class: payClass,
        union_local: currentUnionLocal,
        certified_class: certifiedClass,
        date: convertDate(currentDate),
        hours: hours,
        rate: rate,
        cost_code: costCode,
        job_description: jobDescription
      });
    } else {
      const looksLikeEntry = /[A-Z]\d?\s+\d{3}\s+[A-Z]{2}\d{2}[A-Z][A-Z0-9]/.test(line);
      const hasHours = /\d+\.\d{1,2}/.test(line);
      if (looksLikeEntry && hasHours) {
        ignoredLines.push(line.trim());
      }
    }
  }

  const parsedHours = entries.reduce((sum, entry) => sum + (Number(entry.hours) || 0), 0);
  const detectedTotalHours = detectedTotals.length ? Math.max(...detectedTotals) : null;

  return {
    entries,
    summary: {
      parsedHours,
      detectedTotalHours,
      ignoredLines
    }
  };
}

function parseNumber(value) {
  if (value === undefined || value === null) return 0;
  const clean = value.toString().replace(/[^\d.]/g, '');
  return parseFloat(clean) || 0;
}

/**
 * Convert MM/DD/YY to YYYY-MM-DD
 */
function convertDate(dateStr) {
  const [month, day, year] = dateStr.split('/');
  const fullYear = parseInt(year) < 50 ? `20${year}` : `19${year}`;
  return `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

module.exports = {
  parsePayrollPDF
};
