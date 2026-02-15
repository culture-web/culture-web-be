const express = require('express');
const { authenticateToken, optionalAuth } = require('../middleware/authMiddleware');
const proficiencyController = require('../controllers/proficiencyController');

const router = express.Router();

// GET /api/proficiency/summary - Get user's proficiency summary (requires auth)
router.get('/summary', authenticateToken, proficiencyController.getUserProficiencySummary);

// GET /api/proficiency/details - Get user's detailed proficiency states (requires auth)
router.get('/details', authenticateToken, proficiencyController.getUserProficiencyDetails);

// GET /api/proficiency/concepts/:conceptId - Get proficiency for specific concept (requires auth)
router.get('/concepts/:conceptId', authenticateToken, proficiencyController.getConceptProficiency);

// GET /api/proficiency/suggestions - Get learning path suggestions (requires auth)
router.get('/suggestions', authenticateToken, proficiencyController.getLearningPathSuggestions);

// GET /api/proficiency/search - Search concepts (auth optional)
router.get('/search', optionalAuth, proficiencyController.searchConcepts);

// GET /api/proficiency/curriculum - Get curriculum overview (auth optional)
router.get('/curriculum', optionalAuth, proficiencyController.getCurriculumOverview);

// GET /api/proficiency/categories/:category - Get concepts by category (auth optional)  
router.get('/categories/:category', optionalAuth, proficiencyController.getConceptsByCategory);

module.exports = router;