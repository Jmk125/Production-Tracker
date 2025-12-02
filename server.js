const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const { 
  initDatabase,
  projectQueries,
  uploadQueries,
  budgetQueries,
  timeEntryQueries,
  comparisonQueries,
  areaQueries
} = require('./database');

const { parsePayrollPDF } = require('./pdfParser');

const app = express();
const PORT = process.env.PORT || 3030;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Create uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Normalize cost codes to numeric-only strings (drops decimals)
function normalizeCostCode(value) {
  if (value === undefined || value === null) return null;
  const [mainPart] = value.toString().split('.');
  const numeric = mainPart.replace(/\D/g, '').trim();
  return numeric || null;
}

function normalizeJobLabel(value) {
  if (!value) return 'unspecified';
  return value.toString().trim().toLowerCase();
}

// Align budget codes to payroll codes by matching on numeric prefixes
function alignBudgetCostCodes(budgetHours = {}, actualTotals = {}) {
  const aligned = {};

  // Both budget and actual codes are already normalized, so just use budget codes directly
  Object.entries(budgetHours || {}).forEach(([budgetCode, hours]) => {
    if (!budgetCode) return;
    aligned[budgetCode] = (aligned[budgetCode] || 0) + hours;
  });

  return aligned;
}

function alignCostCodeNames(budgetNames = {}, actualTotals = {}) {
  const aligned = {};

  // Both budget and actual codes are already normalized, so just use budget names directly
  Object.entries(budgetNames || {}).forEach(([budgetCode, name]) => {
    if (!budgetCode || !name) return;
    if (!aligned[budgetCode]) {
      aligned[budgetCode] = name;
    }
  });

  return aligned;
}

async function buildBudgetComparison(projectId, latestBudget = null) {
  const [budgetUploads, actualTotals] = await Promise.all([
    budgetQueries.getByProject(projectId),
    timeEntryQueries.getCostCodeTotals(projectId)
  ]);

  const budgetHours = latestBudget ? latestBudget.cost_code_hours : (budgetUploads[0]?.cost_code_hours || {});
  const budgetNames = latestBudget ? (latestBudget.cost_code_names || {}) : (budgetUploads[0]?.cost_code_names || {});

  const alignedBudget = alignBudgetCostCodes(budgetHours, actualTotals);
  const alignedCostCodeNames = alignCostCodeNames(budgetNames, actualTotals);
  const allCodes = new Set([
    ...Object.keys(alignedBudget || {}),
    ...Object.keys(actualTotals || {})
  ]);

  const comparison = Array.from(allCodes).map(code => {
    const budget = alignedBudget?.[code] || 0;
    const actual = actualTotals?.[code] || 0;
    const variance = actual - budget;
    const variancePercent = budget > 0 ? (variance / budget) * 100 : null;

    return {
      cost_code: code,
      cost_code_name: alignedCostCodeNames?.[code] || null,
      budget_hours: budget,
      actual_hours: actual,
      variance_hours: variance,
      variance_percent: variancePercent
    };
  }).sort((a, b) => a.cost_code.localeCompare(b.cost_code));

  return { comparison, latestBudget: budgetUploads[0] || null, budgetUploads, costCodeNames: alignedCostCodeNames };
}

async function buildAreaComparison(projectId, latestBudget = null) {
  const [latestBudgetUpload, areaConfig, jobTotals, jobCostCodes] = await Promise.all([
    latestBudget ? Promise.resolve(latestBudget) : budgetQueries.getLatestByProject(projectId),
    areaQueries.getByProject(projectId),
    timeEntryQueries.getJobTotals(projectId),
    timeEntryQueries.getJobCostCodeTotals(projectId)
  ]);

  const budgetAreasRaw = latestBudgetUpload?.area_hours || {};
  const budgetCostCodeAreas = latestBudgetUpload?.area_cost_code_hours || {};
  const budgetAreas = Object.entries(budgetAreasRaw).map(([label, hours]) => ({
    key: normalizeJobLabel(label),
    label,
    hours: Number(hours) || 0
  })).filter(area => area.key);

  const actualTotals = jobTotals.totals || {};
  const actualLabels = jobTotals.labels || {};

  const actualCostCodesAggregated = {};
  const budgetCostCodesAggregated = {};
  const mappings = areaConfig.mappings || {};
  const adjustments = areaConfig.adjustments || { budget: {}, actual: {} };

  Object.entries(jobCostCodes || {}).forEach(([key, data]) => {
    const normalized = normalizeJobLabel(key);
    if (!normalized) return;

    actualCostCodesAggregated[normalized] = actualCostCodesAggregated[normalized] || { costCodes: {}, total: 0 };

    Object.entries(data.costCodes || {}).forEach(([code, hours]) => {
      const normalizedCode = code || 'Unspecified';
      actualCostCodesAggregated[normalized].costCodes[normalizedCode] =
        (actualCostCodesAggregated[normalized].costCodes[normalizedCode] || 0) + (Number(hours) || 0);
      actualCostCodesAggregated[normalized].total += Number(hours) || 0;
    });
  });

  Object.entries(budgetCostCodeAreas || {}).forEach(([label, codes]) => {
    const normalizedArea = normalizeJobLabel(label);
    if (!normalizedArea) return;

    const mappedKey = mappings[normalizedArea] || (actualTotals[normalizedArea] !== undefined ? normalizedArea : null);
    const targetKey = mappedKey || normalizedArea;

    budgetCostCodesAggregated[targetKey] = budgetCostCodesAggregated[targetKey] || { costCodes: {}, total: 0 };

    Object.entries(codes || {}).forEach(([code, hours]) => {
      const normalizedCode = normalizeCostCode(code) || code || 'Unspecified';
      const numericHours = Number(hours) || 0;
      budgetCostCodesAggregated[targetKey].costCodes[normalizedCode] =
        (budgetCostCodesAggregated[targetKey].costCodes[normalizedCode] || 0) + numericHours;
      budgetCostCodesAggregated[targetKey].total += numericHours;
    });
  });

  const budgetAggregated = {};
  const labelMap = { ...actualLabels };

  budgetAreas.forEach(area => {
    const mappedKey = mappings[area.key] || (actualTotals[area.key] !== undefined ? area.key : null);
    const targetKey = mappedKey || area.key;
    budgetAggregated[targetKey] = (budgetAggregated[targetKey] || 0) + area.hours;
    if (!labelMap[targetKey]) {
      labelMap[targetKey] = mappedKey && actualLabels[mappedKey]
        ? actualLabels[mappedKey]
        : area.label;
    }
  });

  Object.entries(adjustments.budget || {}).forEach(([key, hours]) => {
    const normalized = normalizeJobLabel(key);
    budgetAggregated[normalized] = (budgetAggregated[normalized] || 0) + (Number(hours) || 0);
    if (!labelMap[normalized]) labelMap[normalized] = key;
  });

  const actualAggregated = { ...actualTotals };
  Object.entries(adjustments.actual || {}).forEach(([key, hours]) => {
    const normalized = normalizeJobLabel(key);
    actualAggregated[normalized] = (actualAggregated[normalized] || 0) + (Number(hours) || 0);
    if (!labelMap[normalized]) labelMap[normalized] = key;

    actualCostCodesAggregated[normalized] = actualCostCodesAggregated[normalized] || { costCodes: {}, total: 0 };
    actualCostCodesAggregated[normalized].costCodes['Adjustment'] =
      (actualCostCodesAggregated[normalized].costCodes['Adjustment'] || 0) + (Number(hours) || 0);
    actualCostCodesAggregated[normalized].total += Number(hours) || 0;
  });

  Object.entries(adjustments.budget || {}).forEach(([key, hours]) => {
    const normalized = normalizeJobLabel(key);
    budgetCostCodesAggregated[normalized] = budgetCostCodesAggregated[normalized] || { costCodes: {}, total: 0 };
    budgetCostCodesAggregated[normalized].costCodes['Adjustment'] =
      (budgetCostCodesAggregated[normalized].costCodes['Adjustment'] || 0) + (Number(hours) || 0);
    budgetCostCodesAggregated[normalized].total += Number(hours) || 0;
  });

  const allKeys = new Set([
    ...Object.keys(budgetAggregated),
    ...Object.keys(actualAggregated)
  ]);

  const comparison = Array.from(allKeys).map(key => {
    const budget = budgetAggregated[key] || 0;
    const actual = actualAggregated[key] || 0;
    const variance = actual - budget;
    const variancePercent = budget > 0 ? (variance / budget) * 100 : null;

    return {
      key,
      area: labelMap[key] || key,
      budget_hours: budget,
      actual_hours: actual,
      variance_hours: variance,
      variance_percent: variancePercent
    };
  }).sort((a, b) => a.area.localeCompare(b.area));

  const costCodeBreakdown = {};

  const buildCostCodeBreakdown = (targetKey, budgetTotal = 0) => {
    const actualBreakdown = actualCostCodesAggregated[targetKey] || { costCodes: {}, total: 0 };
    const budgetBreakdown = budgetCostCodesAggregated[targetKey] || { costCodes: {}, total: 0 };

    const allCodes = new Set([
      ...Object.keys(actualBreakdown.costCodes || {}),
      ...Object.keys(budgetBreakdown.costCodes || {})
    ]);

    const costCodeEntries = Array.from(allCodes).map(code => {
      const actualHours = Number(actualBreakdown.costCodes?.[code]) || 0;
      const budgetHours = Number(budgetBreakdown.costCodes?.[code]) || 0;
      const varianceHours = actualHours - budgetHours;

      return {
        cost_code: code,
        actual_hours: actualHours,
        budget_hours: budgetHours,
        variance_hours: varianceHours,
        variance_percent: budgetHours > 0 ? (varianceHours / budgetHours) * 100 : null
      };
    });

    if (budgetTotal > 0 && costCodeEntries.length === 0) {
      costCodeEntries.push({
        cost_code: 'Budget',
        actual_hours: 0,
        budget_hours: budgetTotal,
        variance_hours: -budgetTotal,
        variance_percent: -100
      });
    }

    const allocatedBudget = costCodeEntries.reduce((sum, entry) => sum + entry.budget_hours, 0);
    if (budgetTotal > 0 && costCodeEntries.length > 0) {
      const delta = budgetTotal - allocatedBudget;
      const lastEntry = costCodeEntries[costCodeEntries.length - 1];
      lastEntry.budget_hours += delta;
      lastEntry.variance_hours = lastEntry.actual_hours - lastEntry.budget_hours;
      lastEntry.variance_percent = lastEntry.budget_hours !== 0
        ? (lastEntry.variance_hours / lastEntry.budget_hours) * 100
        : null;
    }

    const actualTotal = costCodeEntries.reduce((sum, entry) => sum + (Number(entry.actual_hours) || 0), 0);

    return {
      entries: costCodeEntries,
      totalActual: actualTotal,
      totalBudget: budgetTotal
    };
  };

  comparison.forEach(row => {
    costCodeBreakdown[row.key] = buildCostCodeBreakdown(row.key, row.budget_hours);
  });

  const actualAreas = Object.keys(actualTotals).map(key => ({
    key,
    label: actualLabels[key] || key,
    hours: actualTotals[key] || 0
  })).sort((a, b) => a.label.localeCompare(b.label));

  return {
    comparison,
    budgetAreas,
    actualAreas,
    mappings,
    adjustments,
    costCodeBreakdown
  };
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// Initialize database
initDatabase();

// ===== PROJECT ROUTES =====

// Get all projects
app.get('/api/projects', async (req, res) => {
  try {
    const projects = await projectQueries.getAll();
    res.json(projects);
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// Get single project
app.get('/api/projects/:id', async (req, res) => {
  try {
    const project = await projectQueries.getById(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(project);
  } catch (error) {
    console.error('Error fetching project:', error);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

// Create project
app.post('/api/projects', async (req, res) => {
  try {
    const { name, size, size_unit, start_date, end_date, notes } = req.body;
    const result = await projectQueries.create(name, size, size_unit, start_date, end_date, notes);
    const project = await projectQueries.getById(result.lastID);
    res.json(project);
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// Update project
app.put('/api/projects/:id', async (req, res) => {
  try {
    const { name, size, size_unit, start_date, end_date, notes } = req.body;
    await projectQueries.update(name, size, size_unit, start_date, end_date, notes, req.params.id);
    const project = await projectQueries.getById(req.params.id);
    res.json(project);
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

// Delete project
app.delete('/api/projects/:id', async (req, res) => {
  try {
    await projectQueries.delete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

// ===== UPLOAD ROUTES =====

// Upload payroll PDF
app.post('/api/projects/:id/upload', upload.single('payroll'), async (req, res) => {
  try {
    const projectId = req.params.id;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Create upload record
    const uploadResult = await uploadQueries.create(projectId, file.originalname);
    const uploadId = uploadResult.lastID;
    
    // Parse PDF
    console.log('Parsing PDF:', file.path);
    const entries = await parsePayrollPDF(file.path);
    console.log(`Extracted ${entries.length} time entries`);
    
    // Prepare entries for batch insert
    console.log('Inserting entries into database...');
    const entryDataArray = entries.map(entry => ({
      project_id: projectId,
      upload_id: uploadId,
      employee_name: entry.employee_name,
      pay_id: entry.pay_id,
      pay_class: entry.pay_class,
      union_local: entry.union_local,
      certified_class: entry.certified_class,
      date: entry.date,
      hours: entry.hours,
      rate: entry.rate,
      cost_code: entry.cost_code,
      job_description: entry.job_description
    }));
    
    // Batch insert all entries at once
    const inserted = await timeEntryQueries.createBatch(entryDataArray);
    console.log(`Successfully inserted ${inserted} entries`);
    
    res.json({ 
      success: true, 
      uploadId,
      entriesFound: entries.length,
      entriesInserted: inserted
    });
  } catch (error) {
    console.error('Error uploading payroll:', error);
    res.status(500).json({ error: 'Failed to process payroll file' });
  }
});

// Save budget hours (parsed client-side from Excel)
app.post('/api/projects/:id/budget', async (req, res) => {
  try {
    const projectId = req.params.id;
    const { filename, costCodeHours, areaHours, areaCostCodeHours, costCodeNames } = req.body;

    if (!costCodeHours || typeof costCodeHours !== 'object') {
      return res.status(400).json({ error: 'No budget data provided' });
    }

    const normalizedHours = {};
    Object.entries(costCodeHours).forEach(([code, hours]) => {
      const normalizedCode = normalizeCostCode(code);
      const numericHours = parseFloat(hours);
      if (!normalizedCode || !Number.isFinite(numericHours)) return;
      normalizedHours[normalizedCode] = (normalizedHours[normalizedCode] || 0) + numericHours;
    });

    if (Object.keys(normalizedHours).length === 0) {
      return res.status(400).json({ error: 'No valid cost code hours found in upload' });
    }

    const areaHoursClean = {};
    if (areaHours && typeof areaHours === 'object') {
      Object.entries(areaHours).forEach(([name, hours]) => {
        if (!name) return;
        const numericHours = parseFloat(hours);
        if (!Number.isFinite(numericHours)) return;
        areaHoursClean[name.trim()] = (areaHoursClean[name.trim()] || 0) + numericHours;
      });
    }

    const areaCostCodeHoursClean = {};
    if (areaCostCodeHours && typeof areaCostCodeHours === 'object') {
      Object.entries(areaCostCodeHours).forEach(([areaName, codes]) => {
        if (!areaName || typeof codes !== 'object') return;

        Object.entries(codes).forEach(([code, hours]) => {
          const normalizedCode = normalizeCostCode(code);
          const numericHours = parseFloat(hours);
          if (!normalizedCode || !Number.isFinite(numericHours)) return;

          const cleanArea = areaName.trim();
          areaCostCodeHoursClean[cleanArea] = areaCostCodeHoursClean[cleanArea] || {};
          areaCostCodeHoursClean[cleanArea][normalizedCode] =
            (areaCostCodeHoursClean[cleanArea][normalizedCode] || 0) + numericHours;
        });
      });
    }

    const costCodeNamesClean = {};
    if (costCodeNames && typeof costCodeNames === 'object') {
      Object.entries(costCodeNames).forEach(([code, name]) => {
        const normalizedCode = normalizeCostCode(code);
        const cleanName = name?.toString().trim();
        if (!normalizedCode || !cleanName) return;
        if (!costCodeNamesClean[normalizedCode]) {
          costCodeNamesClean[normalizedCode] = cleanName;
        }
      });
    }

    const result = await budgetQueries.create(projectId, filename || 'Budget Upload', normalizedHours, areaHoursClean, costCodeNamesClean, areaCostCodeHoursClean);
    const { comparison, latestBudget, budgetUploads, costCodeNames: alignedCostCodeNames } = await buildBudgetComparison(projectId, { cost_code_hours: normalizedHours, area_hours: areaHoursClean, cost_code_names: costCodeNamesClean, area_cost_code_hours: areaCostCodeHoursClean });
    const areaComparison = await buildAreaComparison(projectId, { area_hours: areaHoursClean, area_cost_code_hours: areaCostCodeHoursClean });

    res.json({
      success: true,
      budgetId: result.lastID,
      codesTracked: Object.keys(normalizedHours).length,
      uploads: budgetUploads,
      latest: latestBudget,
      comparison,
      areaComparison,
      costCodeNames: alignedCostCodeNames
    });
  } catch (error) {
    console.error('Error saving budget:', error);
    res.status(500).json({ error: 'Failed to save budget upload' });
  }
});

// Get budget summary and uploads
app.get('/api/projects/:id/budget', async (req, res) => {
  try {
    const { comparison, latestBudget, budgetUploads, costCodeNames } = await buildBudgetComparison(req.params.id);
    const areaComparison = await buildAreaComparison(req.params.id);
    res.json({
      uploads: budgetUploads,
      latest: latestBudget,
      comparison,
      areaComparison,
      costCodeNames
    });
  } catch (error) {
    console.error('Error fetching budget data:', error);
    res.status(500).json({ error: 'Failed to fetch budget data' });
  }
});

// Get building/area comparison
app.get('/api/projects/:id/areas', async (req, res) => {
  try {
    const areaData = await buildAreaComparison(req.params.id);
    res.json(areaData);
  } catch (error) {
    console.error('Error fetching area data:', error);
    res.status(500).json({ error: 'Failed to fetch area comparison' });
  }
});

// Save area mappings
app.post('/api/projects/:id/areas/mappings', async (req, res) => {
  try {
    const { mappings } = req.body;
    await areaQueries.saveMappings(req.params.id, mappings || {});
    const areaData = await buildAreaComparison(req.params.id);
    res.json(areaData);
  } catch (error) {
    console.error('Error saving area mappings:', error);
    res.status(500).json({ error: 'Failed to save area mappings' });
  }
});

// Save area adjustments
app.post('/api/projects/:id/areas/adjustments', async (req, res) => {
  try {
    const { budgetAdjustments, actualAdjustments } = req.body;
    await areaQueries.saveAdjustments(req.params.id, budgetAdjustments || {}, actualAdjustments || {});
    const areaData = await buildAreaComparison(req.params.id);
    res.json(areaData);
  } catch (error) {
    console.error('Error saving area adjustments:', error);
    res.status(500).json({ error: 'Failed to save area adjustments' });
  }
});

// Get uploads for project
app.get('/api/projects/:id/uploads', async (req, res) => {
  try {
    const uploads = await uploadQueries.getByProject(req.params.id);
    res.json(uploads);
  } catch (error) {
    console.error('Error fetching uploads:', error);
    res.status(500).json({ error: 'Failed to fetch uploads' });
  }
});

// ===== TIME ENTRY ROUTES =====

// Get time entries for project
app.get('/api/projects/:id/entries', async (req, res) => {
  try {
    const entries = await timeEntryQueries.getByProject(req.params.id);
    res.json(entries);
  } catch (error) {
    console.error('Error fetching entries:', error);
    res.status(500).json({ error: 'Failed to fetch time entries' });
  }
});

// Get monthly statistics for project
app.get('/api/projects/:id/stats/monthly', async (req, res) => {
  try {
    const stats = await timeEntryQueries.getMonthlyStats(req.params.id);
    res.json(stats);
  } catch (error) {
    console.error('Error fetching monthly stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Get detailed monthly breakdown by category
app.get('/api/projects/:id/stats/monthly-detail', async (req, res) => {
  try {
    const stats = await timeEntryQueries.getMonthlyByCategory(req.params.id);
    res.json(stats);
  } catch (error) {
    console.error('Error fetching detailed stats:', error);
    res.status(500).json({ error: 'Failed to fetch detailed statistics' });
  }
});

// ===== COMPARISON ROUTES =====

// Get comparison data for multiple projects
app.post('/api/comparison/timeline', async (req, res) => {
  try {
    const { projectIds } = req.body;
    
    if (!projectIds || !Array.isArray(projectIds) || projectIds.length === 0) {
      return res.status(400).json({ error: 'Project IDs required' });
    }
    
    const comparisonData = await Promise.all(
      projectIds.map(async (projectId) => {
        const { entries, rawEntries, projectStartDate, employeeStats } = await comparisonQueries.getProjectTimeline(projectId);
        const { comparison: budgetComparison, costCodeNames } = await buildBudgetComparison(projectId);

        const totalBudgetHours = budgetComparison.reduce((sum, row) => sum + (Number(row.budget_hours) || 0), 0);
        const totalActualHours = budgetComparison.reduce((sum, row) => sum + (Number(row.actual_hours) || 0), 0);

        return {
          projectId,
          data: entries,
          rawEntries,
          projectStartDate,
          employeeStats,
          budgetComparison,
          costCodeNames,
          budgetSummary: {
            budgetedHours: totalBudgetHours,
            actualHours: totalActualHours,
            varianceHours: totalActualHours - totalBudgetHours
          }
        };
      })
    );
    
    res.json(comparisonData);
  } catch (error) {
    console.error('Error fetching comparison data:', error);
    res.status(500).json({ error: 'Failed to fetch comparison data' });
  }
});

// ===== SERVE STATIC PAGES =====

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/project/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'project.html'));
});

app.get('/comparison', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'comparison.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Payroll Tracker server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});
