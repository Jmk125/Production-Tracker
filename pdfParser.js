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
    
    // Check for time entry line - made more flexible
    // The key identifiers are: Pay Class (J/F/G/A1-A6), 3-digit pay ID, Cert Class, hours with decimal, rate with 5 decimals, cost code
    // Example: "      J   841       TA01J1       0                 2.50      31.68000           79.207552.  Cuy Fal Bld 1 1st Fl             09-170"
    // More flexible pattern that handles varying spacing and different "7552" vs "7572" endings
    // Cost code pattern updated to handle variable lengths: 1-2 digits, hyphen, 2-5 digits (e.g., "1-400", "09-170", "01-4000")
    const entryMatch = line.match(/^\s+([JFGA]\d?)\s+(\d{3})\s+([A-Z]{2}\d{2}[A-Z]\d)\s+\S+\s+([\d.]+)\s+([\d.]+)\s+[\d.,]+75\d{2}\.\s+(.+?)\s+([\d]{1,2}-[\d]{2,5})/);
    
    if (entryMatch && currentEmployee && currentDate) {
      const payClass = entryMatch[1];
      const payId = entryMatch[2];
      const certifiedClass = entryMatch[3];
      const hours = parseFloat(entryMatch[4]);
      const rate = parseFloat(entryMatch[5]);
      const jobDescription = entryMatch[6].trim();
      const costCode = entryMatch[7];
      
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
    }
  }
  
  return entries;
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
