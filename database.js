const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const UPLOADS_FILE = path.join(DATA_DIR, 'uploads.json');
const ENTRIES_FILE = path.join(DATA_DIR, 'entries.json');
const BUDGETS_FILE = path.join(DATA_DIR, 'budgets.json');
const AREAS_FILE = path.join(DATA_DIR, 'areas.json');

function normalizeCostCode(value) {
  if (value === undefined || value === null) return null;
  const [mainPart] = value.toString().split('.');
  // Keep hyphen, remove other non-digit characters
  let normalized = mainPart.replace(/[^\d-]/g, '').trim();

  // If no hyphen and 4-5 digits, might be missing leading zero from Excel number formatting
  // E.g., "1200" should be "01-200" not "12-00"
  if (normalized && !normalized.includes('-') && normalized.length >= 4 && normalized.length <= 5) {
    // If first digit is 1-9 (not 0), likely missing leading zero
    if (normalized[0] !== '0') {
      normalized = '0' + normalized;
    }
  }

  // If no hyphen and 4+ digits, insert hyphen after first 2 digits (CSI MasterFormat)
  if (normalized && !normalized.includes('-') && normalized.length >= 4) {
    normalized = normalized.slice(0, 2) + '-' + normalized.slice(2);
  }

  return normalized || null;
}

function normalizeJobLabel(value) {
  if (!value) return 'unspecified';
  return value.toString().trim().toLowerCase();
}

// Initialize data directory and files
function initDatabase() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(PROJECTS_FILE)) {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify([]));
  }

  if (!fs.existsSync(UPLOADS_FILE)) {
    fs.writeFileSync(UPLOADS_FILE, JSON.stringify([]));
  }

  if (!fs.existsSync(ENTRIES_FILE)) {
    fs.writeFileSync(ENTRIES_FILE, JSON.stringify([]));
  }

  if (!fs.existsSync(BUDGETS_FILE)) {
    fs.writeFileSync(BUDGETS_FILE, JSON.stringify([]));
  }

  if (!fs.existsSync(AREAS_FILE)) {
    fs.writeFileSync(AREAS_FILE, JSON.stringify([]));
  }

  console.log('Database initialized successfully');
}

// Helper functions to read/write JSON files
function readJSON(filePath) {
  const data = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(data);
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Project queries
const projectQueries = {
  getAll: async () => {
    const projects = readJSON(PROJECTS_FILE);
    return projects.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },

  getById: async (id) => {
    const projects = readJSON(PROJECTS_FILE);
    return projects.find(p => p.id === parseInt(id));
  },

  create: async (name, size, size_unit, start_date, end_date, notes) => {
    const projects = readJSON(PROJECTS_FILE);
    const newProject = {
      id: projects.length > 0 ? Math.max(...projects.map(p => p.id)) + 1 : 1,
      name,
      size,
      size_unit,
      start_date,
      end_date,
      notes,
      created_at: new Date().toISOString()
    };
    projects.push(newProject);
    writeJSON(PROJECTS_FILE, projects);
    return { lastID: newProject.id };
  },

  update: async (name, size, size_unit, start_date, end_date, notes, id) => {
    const projects = readJSON(PROJECTS_FILE);
    const index = projects.findIndex(p => p.id === parseInt(id));
    if (index !== -1) {
      projects[index] = {
        ...projects[index],
        name,
        size,
        size_unit,
        start_date,
        end_date,
        notes
      };
      writeJSON(PROJECTS_FILE, projects);
    }
  },

  delete: async (id) => {
    const projects = readJSON(PROJECTS_FILE);
    const filtered = projects.filter(p => p.id !== parseInt(id));
    writeJSON(PROJECTS_FILE, filtered);

    // Also delete related uploads and entries
    const uploads = readJSON(UPLOADS_FILE);
    const filteredUploads = uploads.filter(u => u.project_id !== parseInt(id));
    writeJSON(UPLOADS_FILE, filteredUploads);

    const entries = readJSON(ENTRIES_FILE);
    const filteredEntries = entries.filter(e => e.project_id !== parseInt(id));
    writeJSON(ENTRIES_FILE, filteredEntries);
  }
};

// Upload queries
const uploadQueries = {
  create: async (project_id, filename) => {
    const uploads = readJSON(UPLOADS_FILE);
    const newUpload = {
      id: uploads.length > 0 ? Math.max(...uploads.map(u => u.id)) + 1 : 1,
      project_id: parseInt(project_id),
      filename,
      upload_date: new Date().toISOString()
    };
    uploads.push(newUpload);
    writeJSON(UPLOADS_FILE, uploads);
    return { lastID: newUpload.id };
  },

  getByProject: async (project_id) => {
    const uploads = readJSON(UPLOADS_FILE);
    return uploads
      .filter(u => u.project_id === parseInt(project_id))
      .sort((a, b) => new Date(b.upload_date) - new Date(a.upload_date));
  }
};

// Budget queries
const budgetQueries = {
  create: async (project_id, filename, cost_code_hours, area_hours = {}, cost_code_names = {}, area_cost_code_hours = {}) => {
    const budgets = readJSON(BUDGETS_FILE);
    const newBudget = {
      id: budgets.length > 0 ? Math.max(...budgets.map(b => b.id)) + 1 : 1,
      project_id: parseInt(project_id),
      filename,
      cost_code_hours,
      area_hours,
      cost_code_names,
      area_cost_code_hours,
      upload_date: new Date().toISOString()
    };

    budgets.push(newBudget);
    writeJSON(BUDGETS_FILE, budgets);
    return { lastID: newBudget.id };
  },

  getByProject: async (project_id) => {
    const budgets = readJSON(BUDGETS_FILE);
    return budgets
      .filter(b => b.project_id === parseInt(project_id))
      .sort((a, b) => new Date(b.upload_date) - new Date(a.upload_date));
  },

  getLatestByProject: async (project_id) => {
    const budgets = await budgetQueries.getByProject(project_id);
    return budgets.length > 0 ? budgets[0] : null;
  }
};

// Time entry queries
const timeEntryQueries = {
  create: async (project_id, upload_id, employee_name, pay_id, pay_class, union_local, certified_class, date, hours, rate, cost_code, job_description) => {
    const entries = readJSON(ENTRIES_FILE);
    const newEntry = {
      id: entries.length > 0 ? Math.max(...entries.map(e => e.id)) + 1 : 1,
      project_id: parseInt(project_id),
      upload_id,
      employee_name,
      pay_id,
      pay_class,
      union_local,
      certified_class,
      date,
      hours,
      rate,
      cost_code,
      job_description
    };
    entries.push(newEntry);
    writeJSON(ENTRIES_FILE, entries);
  },

  createBatch: async (entryDataArray) => {
    const entries = readJSON(ENTRIES_FILE);
    let nextId = entries.length > 0 ? Math.max(...entries.map(e => e.id)) + 1 : 1;
    
    const newEntries = entryDataArray.map(data => ({
      id: nextId++,
      project_id: parseInt(data.project_id),
      upload_id: data.upload_id,
      employee_name: data.employee_name,
      pay_id: data.pay_id,
      pay_class: data.pay_class,
      union_local: data.union_local,
      certified_class: data.certified_class,
      date: data.date,
      hours: data.hours,
      rate: data.rate,
      cost_code: data.cost_code,
      job_description: data.job_description
    }));
    
    entries.push(...newEntries);
    writeJSON(ENTRIES_FILE, entries);
    return newEntries.length;
  },

  getByProject: async (project_id) => {
    const entries = readJSON(ENTRIES_FILE);
    return entries
      .filter(e => e.project_id === parseInt(project_id))
      .sort((a, b) => {
        const dateCompare = new Date(a.date) - new Date(b.date);
        if (dateCompare !== 0) return dateCompare;
        return a.employee_name.localeCompare(b.employee_name);
      });
  },

  getMonthlyStats: async (project_id) => {
    const entries = readJSON(ENTRIES_FILE);
    const projectEntries = entries.filter(e => e.project_id === parseInt(project_id));

    const monthlyData = {};
    projectEntries.forEach(entry => {
      const month = entry.date.substring(0, 7); // YYYY-MM
      if (!monthlyData[month]) {
        monthlyData[month] = {
          total_hours: 0,
          employees: new Set(),
          days: {}
        };
      }
      monthlyData[month].total_hours += Number(entry.hours) || 0;
      monthlyData[month].employees.add(entry.employee_name);

      if (!monthlyData[month].days[entry.date]) {
        monthlyData[month].days[entry.date] = new Set();
      }
      monthlyData[month].days[entry.date].add(entry.employee_name);
    });

    return Object.keys(monthlyData)
      .sort()
      .map(month => {
        const dayEmployeeCounts = Object.values(monthlyData[month].days).map(set => set.size);
        const averageDailyEmployeesRaw = dayEmployeeCounts.length > 0
          ? dayEmployeeCounts.reduce((sum, count) => sum + count, 0) / dayEmployeeCounts.length
          : 0;

        return {
          month,
          total_hours: monthlyData[month].total_hours,
          employee_count: monthlyData[month].employees.size,
          average_daily_employees: Number(averageDailyEmployeesRaw.toFixed(2))
        };
      });
  },

  getMonthlyByCategory: async (project_id) => {
    const entries = readJSON(ENTRIES_FILE);
    const projectEntries = entries.filter(e => e.project_id === parseInt(project_id));

    const result = [];
    const aggregated = {};

    projectEntries.forEach(entry => {
      const month = entry.date.substring(0, 7);
      const key = `${month}|${entry.cost_code}|${entry.pay_class}|${entry.job_description}|${entry.employee_name}`;

      if (!aggregated[key]) {
        aggregated[key] = {
          month,
          cost_code: entry.cost_code,
          pay_class: entry.pay_class,
          job_description: entry.job_description,
          employee_name: entry.employee_name,
          total_hours: 0
        };
      }
      aggregated[key].total_hours += Number(entry.hours) || 0;
    });

    return Object.values(aggregated).sort((a, b) => a.month.localeCompare(b.month));
  },

  getCostCodeTotals: async (project_id) => {
    const entries = readJSON(ENTRIES_FILE);
    const projectEntries = entries.filter(e => e.project_id === parseInt(project_id));

    const totals = {};
    projectEntries.forEach(entry => {
      if (!entry.cost_code) return;
      const code = normalizeCostCode(entry.cost_code);
      if (!code) return;
      totals[code] = (totals[code] || 0) + (Number(entry.hours) || 0);
    });

    return totals;
  },

  getJobTotals: async (project_id) => {
    const entries = readJSON(ENTRIES_FILE);
    const projectEntries = entries.filter(e => e.project_id === parseInt(project_id));

    const totals = {};
    const labels = {};

    projectEntries.forEach(entry => {
      const key = normalizeJobLabel(entry.job_description);
      if (!key) return;

      totals[key] = (totals[key] || 0) + (Number(entry.hours) || 0);
      if (!labels[key] && entry.job_description) {
        labels[key] = entry.job_description;
      }
    });

    return { totals, labels };
  },

  getJobCostCodeTotals: async (project_id) => {
    const entries = readJSON(ENTRIES_FILE);
    const projectEntries = entries.filter(e => e.project_id === parseInt(project_id));

    const result = {};

    projectEntries.forEach(entry => {
      const jobKey = normalizeJobLabel(entry.job_description);
      if (!jobKey) return;

      const costCode = normalizeCostCode(entry.cost_code) || 'Unspecified';
      const hours = Number(entry.hours) || 0;

      if (!result[jobKey]) {
        result[jobKey] = {
          label: entry.job_description || jobKey,
          costCodes: {},
          total: 0
        };
      }

      result[jobKey].costCodes[costCode] = (result[jobKey].costCodes[costCode] || 0) + hours;
      result[jobKey].total += hours;

      if (!result[jobKey].label && entry.job_description) {
        result[jobKey].label = entry.job_description;
      }
    });

    return result;
  }
};

const areaQueries = {
  getByProject: async (project_id) => {
    const areas = readJSON(AREAS_FILE);
    return areas.find(a => a.project_id === parseInt(project_id)) || {
      project_id: parseInt(project_id),
      mappings: {},
      adjustments: { budget: {}, actual: {} }
    };
  },

  saveMappings: async (project_id, mappings = {}) => {
    const areas = readJSON(AREAS_FILE);
    const index = areas.findIndex(a => a.project_id === parseInt(project_id));

    const existing = index !== -1 ? areas[index] : {
      project_id: parseInt(project_id),
      mappings: {},
      adjustments: { budget: {}, actual: {} }
    };

    existing.mappings = { ...existing.mappings, ...mappings };

    if (index !== -1) {
      areas[index] = existing;
    } else {
      areas.push(existing);
    }

    writeJSON(AREAS_FILE, areas);
    return existing;
  },

  saveAdjustments: async (project_id, budgetAdjustments = {}, actualAdjustments = {}) => {
    const areas = readJSON(AREAS_FILE);
    const index = areas.findIndex(a => a.project_id === parseInt(project_id));

    const existing = index !== -1 ? areas[index] : {
      project_id: parseInt(project_id),
      mappings: {},
      adjustments: { budget: {}, actual: {} }
    };

    existing.adjustments = {
      budget: { ...existing.adjustments.budget, ...budgetAdjustments },
      actual: { ...existing.adjustments.actual, ...actualAdjustments }
    };

    if (index !== -1) {
      areas[index] = existing;
    } else {
      areas.push(existing);
    }

    writeJSON(AREAS_FILE, areas);
    return existing;
  }
};

// Comparison queries
const comparisonQueries = {
  getProjectTimeline: async (project_id) => {
    const entries = readJSON(ENTRIES_FILE);
    const projects = readJSON(PROJECTS_FILE);

    const projectEntries = entries.filter(e => e.project_id === parseInt(project_id));
    const project = projects.find(p => p.id === parseInt(project_id));

    if (projectEntries.length === 0) {
      return {
        entries: [],
        employeeStats: {
          projectTimeline: {},
          calendarTimeline: {}
        }
      };
    }

    // Find the first date for this project
    const dates = projectEntries.map(e => new Date(e.date));
    const firstDate = new Date(Math.min(...dates));
    const projectStartDate = firstDate.toISOString().substring(0, 10);

    const aggregated = {};
    const projectMonthStats = {};
    const calendarMonthStats = {};

    projectEntries.forEach(entry => {
      const entryDate = new Date(entry.date);
      const hours = Number(entry.hours) || 0;
      const monthsDiff = Math.floor((entryDate - firstDate) / (30.44 * 24 * 60 * 60 * 1000)) + 1;
      const calendarMonth = entry.date.substring(0, 7);

      if (!projectMonthStats[monthsDiff]) {
        projectMonthStats[monthsDiff] = { unique: new Set(), days: {} };
      }
      if (!projectMonthStats[monthsDiff].days[entry.date]) {
        projectMonthStats[monthsDiff].days[entry.date] = new Set();
      }
      projectMonthStats[monthsDiff].unique.add(entry.employee_name);
      projectMonthStats[monthsDiff].days[entry.date].add(entry.employee_name);

      if (!calendarMonthStats[calendarMonth]) {
        calendarMonthStats[calendarMonth] = { unique: new Set(), days: {} };
      }
      if (!calendarMonthStats[calendarMonth].days[entry.date]) {
        calendarMonthStats[calendarMonth].days[entry.date] = new Set();
      }
      calendarMonthStats[calendarMonth].unique.add(entry.employee_name);
      calendarMonthStats[calendarMonth].days[entry.date].add(entry.employee_name);

      const key = `${calendarMonth}|${monthsDiff}|${entry.cost_code}|${entry.pay_class}|${entry.job_description}|${entry.employee_name}`;

      if (!aggregated[key]) {
        aggregated[key] = {
          project_id: parseInt(project_id),
          project_name: project ? project.name : `Project ${project_id}`,
          calendar_month: calendarMonth,
          project_month: monthsDiff,
          cost_code: entry.cost_code,
          pay_class: entry.pay_class,
          job_description: entry.job_description,
          employee_name: entry.employee_name,
          total_hours: 0
        };
      }
      aggregated[key].total_hours += hours;
    });

    const buildEmployeeStats = (statMap) => Object.entries(statMap).reduce((acc, [key, value]) => {
      const dayCounts = Object.values(value.days).map(set => set.size);
      const averageDailyEmployeesRaw = dayCounts.length > 0
        ? dayCounts.reduce((sum, count) => sum + count, 0) / dayCounts.length
        : 0;

      acc[key] = {
        uniqueEmployees: value.unique.size,
        averageDailyEmployees: Number(averageDailyEmployeesRaw.toFixed(2))
      };
      return acc;
    }, {});

    return {
      entries: Object.values(aggregated).sort((a, b) => a.project_month - b.project_month),
      rawEntries: projectEntries,
      projectStartDate,
      employeeStats: {
        projectTimeline: buildEmployeeStats(projectMonthStats),
        calendarTimeline: buildEmployeeStats(calendarMonthStats)
      }
    };
  }
};

module.exports = {
  initDatabase,
  projectQueries,
  uploadQueries,
  budgetQueries,
  timeEntryQueries,
  comparisonQueries,
  areaQueries
};
