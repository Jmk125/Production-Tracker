# Payroll Tracker

A comprehensive web-based application for tracking and analyzing construction payroll data. Designed to run on a Raspberry Pi with a Node.js server.

## Features

### Project Management
- Create and manage multiple construction projects
- Track project details (size, start/end dates, notes)
- Organize payroll data by project

### PDF Upload & Parsing
- Upload payroll PDF reports
- Automatic extraction of time entry data including:
  - Employee names and pay IDs
  - Pay classes (Journeyman, Foreman, etc.)
  - Hours worked by date
  - Cost codes
  - Job descriptions (buildings/areas)
  - Hourly rates

### Data Visualization
- **Monthly Hours Chart** - Track total hours over time
- **Breakdown Views**:
  - By Cost Code
  - By Pay Class
  - By Job/Building
  - By Individual Employee
- Interactive charts powered by Chart.js

### Multi-Project Comparison
- Compare labor patterns across multiple projects
- **Project Timeline Comparison** - Month 1 vs Month 1, Month 2 vs Month 2
- **Calendar Timeline Comparison** - Compare by actual calendar dates
- Comparative metrics:
  - Total hours
  - Average hours per month
  - Employee counts
  - Project duration

### Data Export
- View all time entries in sortable table
- Search and filter capabilities
- Track upload history

## Installation

### Prerequisites
- Node.js (v14 or higher)
- npm

### Setup

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

3. Open your browser to:
```
http://localhost:3000
```

For development with auto-restart:
```bash
npm run dev
```

## Usage

### 1. Create a Project
1. Click "Add Project" on the main page
2. Enter project details:
   - Name (required)
   - Size and unit (optional)
   - Start and end dates (optional)
   - Notes (optional)
3. Click "Save Project"

### 2. Upload Payroll Data
1. Click on a project to open its dashboard
2. Navigate to the "Upload Payroll" tab
3. Drag and drop a payroll PDF or click to browse
4. The system will automatically parse and extract time entries
5. View the results summary

### 3. Analyze Data
1. Go to the "Overview" tab
2. Select different view types from the dropdown:
   - Total Hours - Overall monthly hours
   - By Cost Code - Hours distributed by cost code
   - By Pay Class - Hours by employee classification
   - By Job/Building - Hours by project area
   - By Employee - Individual employee hours
3. View summary statistics and recent uploads

### 4. Compare Projects
1. Navigate to the "Comparison" page
2. Select 2 or more projects from the checkboxes
3. Click "Compare Selected"
4. Choose timeline type:
   - Project Timeline - Normalized by project month
   - Calendar Timeline - By actual calendar dates
5. Select view type (Total, By Cost Code, etc.)
6. View comparative metrics below the chart

## File Structure

```
payroll-tracker/
├── server.js              # Express server and API routes
├── database.js            # JSON-based data storage
├── pdfParser.js          # PDF parsing logic
├── package.json          # Dependencies
├── data/                 # JSON data files (auto-created)
├── uploads/              # Uploaded PDF files (auto-created)
├── public/               # Frontend files
│   ├── index.html        # Projects list page
│   ├── project.html      # Project dashboard
│   ├── comparison.html   # Multi-project comparison
│   └── style.css         # Stylesheet
└── example_payroll.pdf   # Example payroll report

```

## Data Storage

This application uses a simple JSON file-based storage system, which is perfect for running on a Raspberry Pi without needing a full database server. Data is stored in three files:

- `data/projects.json` - Project information
- `data/uploads.json` - Upload history
- `data/entries.json` - Time entry records

## Deploying to Raspberry Pi

1. Transfer the entire `payroll-tracker` folder to your Raspberry Pi

2. SSH into your Pi and navigate to the folder:
```bash
cd /path/to/payroll-tracker
```

3. Install dependencies:
```bash
npm install --production
```

4. Start the server:
```bash
npm start
```

5. To keep it running persistently, use PM2:
```bash
npm install -g pm2
pm2 start server.js --name payroll-tracker
pm2 save
pm2 startup
```

6. Access from other devices on your network:
```
http://<raspberry-pi-ip>:3000
```

## PDF Format Requirements

The application is designed to parse payroll PDFs with the following structure:
- Employee names followed by pay IDs
- Date format: MM/DD/YY
- Hours marked with asterisks (*)
- Cost codes in format: XX-XXX
- Job descriptions with building/area names

See `example_payroll.pdf` for a reference format.

## Future Enhancements

Potential improvements:
- Export data to Excel
- Email reports
- Budget vs. actual comparisons
- Productivity metrics (hours per SF)
- Historical trend analysis
- Mobile-responsive improvements
- Database migration (JSON → SQLite) for large datasets

## Technical Details

- **Backend**: Node.js with Express
- **Frontend**: Vanilla JavaScript with Chart.js
- **PDF Processing**: pdf-parse library
- **File Storage**: JSON files
- **Port**: 3000 (configurable via PORT environment variable)

## Troubleshooting

### PDF parsing issues
- Ensure PDF format matches expected structure
- Check console logs for parsing errors
- Verify PDF is text-based (not scanned image)

### Server won't start
- Check if port 3000 is already in use
- Verify Node.js installation: `node --version`
- Check for errors in console output

### Missing data after upload
- Check the "Upload History" section
- Review browser console for JavaScript errors
- Verify PDF contains expected data format

## Support

For questions or issues related to this specific implementation, check the code comments in:
- `server.js` - API endpoints and routing
- `pdfParser.js` - PDF extraction logic
- `database.js` - Data management

## License

This is a custom-built tool for internal construction management use.
