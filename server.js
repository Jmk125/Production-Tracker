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
  comparisonQueries
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

// Align budget codes to payroll codes by matching on numeric prefixes
function alignBudgetCostCodes(budgetHours = {}, actualTotals = {}) {
  const actualCodes = Object.keys(actualTotals || {});
  const aligned = {};

  Object.entries(budgetHours || {}).forEach(([budgetCode, hours]) => {
    if (!budgetCode) return;

    const matchingActual = actualCodes
      .filter(code => budgetCode.startsWith(code))
      .sort((a, b) => b.length - a.length)[0];

    const targetCode = matchingActual || budgetCode;
    aligned[targetCode] = (aligned[targetCode] || 0) + hours;
  });

  return aligned;
}

async function buildBudgetComparison(projectId, latestBudget = null) {
  const [budgetUploads, actualTotals] = await Promise.all([
    budgetQueries.getByProject(projectId),
    timeEntryQueries.getCostCodeTotals(projectId)
  ]);

  const budgetHours = latestBudget ? latestBudget.cost_code_hours : (budgetUploads[0]?.cost_code_hours || {});
  const alignedBudget = alignBudgetCostCodes(budgetHours, actualTotals);
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
      budget_hours: budget,
      actual_hours: actual,
      variance_hours: variance,
      variance_percent: variancePercent
    };
  }).sort((a, b) => a.cost_code.localeCompare(b.cost_code));

  return { comparison, latestBudget: budgetUploads[0] || null, budgetUploads };
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
    const { filename, costCodeHours } = req.body;

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

    const result = await budgetQueries.create(projectId, filename || 'Budget Upload', normalizedHours);
    const { comparison, latestBudget, budgetUploads } = await buildBudgetComparison(projectId, { cost_code_hours: normalizedHours });

    res.json({
      success: true,
      budgetId: result.lastID,
      codesTracked: Object.keys(normalizedHours).length,
      uploads: budgetUploads,
      latest: latestBudget,
      comparison
    });
  } catch (error) {
    console.error('Error saving budget:', error);
    res.status(500).json({ error: 'Failed to save budget upload' });
  }
});

// Get budget summary and uploads
app.get('/api/projects/:id/budget', async (req, res) => {
  try {
    const { comparison, latestBudget, budgetUploads } = await buildBudgetComparison(req.params.id);
    res.json({
      uploads: budgetUploads,
      latest: latestBudget,
      comparison
    });
  } catch (error) {
    console.error('Error fetching budget data:', error);
    res.status(500).json({ error: 'Failed to fetch budget data' });
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
        const { comparison: budgetComparison } = await buildBudgetComparison(projectId);

        const totalBudgetHours = budgetComparison.reduce((sum, row) => sum + (Number(row.budget_hours) || 0), 0);
        const totalActualHours = budgetComparison.reduce((sum, row) => sum + (Number(row.actual_hours) || 0), 0);

        return {
          projectId,
          data: entries,
          rawEntries,
          projectStartDate,
          employeeStats,
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
