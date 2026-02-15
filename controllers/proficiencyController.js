// NOTE (GERALD): Temporary addition of basic routes (no utility yet)

const ProficiencyAssessmentService = require('../services/proficiencyAssessmentService');
const CurriculumService = require('../services/curriculumService');
const supabase = require('../client/supabaseClient');

const proficiencyService = new ProficiencyAssessmentService();
const curriculumService = new CurriculumService();

/**
 * Get user's proficiency summary
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getUserProficiencySummary = async (req, res) => {
  try {
    const { user } = req;
    const userId = user.id;

    const summary = await proficiencyService.getUserProficiencySummary(userId);

    return res.status(200).json({
      success: true,
      data: summary,
    });
  } catch (error) {
    console.error('Error getting user proficiency summary:', error);
    return res.status(500).json({
      error: 'Failed to get proficiency summary',
      details: error.message,
    });
  }
};

/**
 * Get user's detailed proficiency states for all concepts
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getUserProficiencyDetails = async (req, res) => {
  try {
    const { user } = req;
    const userId = user.id;
    const { includeUnlearned = false } = req.query;

    // Get all user's proficiency states from Supabase
    const { data: userStates, error } = await supabase
      .from('user_proficiency_state')
      .select('*')
      .eq('user_id', userId);

    if (error) {
      throw error;
    }

    const filteredStates = {};

    // Process existing states
    userStates.forEach((state) => {
      if (includeUnlearned === 'true' || state.bloom_level !== '0_unseen') {
        const concept = curriculumService.getConcept(state.node_id);
        filteredStates[state.node_id] = {
          bloomLevel: state.bloom_level,
          misconceptionFlag: state.misconception_flag,
          lastEvidence: state.last_evidence,
          lastUpdated: state.updated_at,
          conceptInfo: {
            name: concept?.name || state.node_id,
            description: concept?.description || '',
            prerequisites: concept?.prerequisites || [],
            children: concept?.children || [],
          },
        };
      }
    });

    return res.status(200).json({
      success: true,
      data: filteredStates,
    });
  } catch (error) {
    console.error('Error getting user proficiency details:', error);
    return res.status(500).json({
      error: 'Failed to get proficiency details',
      details: error.message,
    });
  }
};

/**
 * Get proficiency state for a specific concept
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getConceptProficiency = async (req, res) => {
  try {
    const { user } = req;
    const userId = user.id;
    const { conceptId } = req.params;

    if (!curriculumService.conceptExists(conceptId)) {
      return res.status(404).json({
        error: 'Concept not found',
        conceptId,
      });
    }

    const currentStates = await proficiencyService.getCurrentUserStates(
      userId,
      [conceptId],
    );
    const state = currentStates[conceptId];
    const concept = curriculumService.getConcept(conceptId);

    return res.status(200).json({
      success: true,
      data: {
        conceptId,
        conceptInfo: {
          name: concept.name,
          description: concept.description,
          prerequisites: concept.prerequisites || [],
          children: concept.children || [],
          examples: concept.examples || [],
        },
        proficiencyState: state,
      },
    });
  } catch (error) {
    console.error('Error getting concept proficiency:', error);
    return res.status(500).json({
      error: 'Failed to get concept proficiency',
      details: error.message,
    });
  }
};

/**
 * Get learning path suggestions based on current proficiency
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getLearningPathSuggestions = async (req, res) => {
  try {
    const { user } = req;
    const userId = user.id;

    // Get all user's current proficiency states
    const allConcepts = Object.keys(curriculumService.getAllConcepts());
    const currentStates = await proficiencyService.getCurrentUserStates(
      userId,
      allConcepts,
    );

    // Find concepts that the user has learned (not unseen)
    const knownConcepts = allConcepts.filter(
      (conceptId) => currentStates[conceptId]?.bloomLevel !== '0_unseen',
    );

    // Get suggestions for next concepts to learn
    const suggestions =
      curriculumService.getSuggestedNextConcepts(knownConcepts);

    // Enrich suggestions with concept details
    const enrichedSuggestions = suggestions.map((conceptId) => {
      const concept = curriculumService.getConcept(conceptId);
      return {
        conceptId,
        name: concept.name,
        description: concept.description,
        prerequisites: concept.prerequisites || [],
        difficulty: concept.prerequisites?.length || 0, // Simple difficulty metric
      };
    });

    // Sort by difficulty (fewer prerequisites = easier)
    enrichedSuggestions.sort((a, b) => a.difficulty - b.difficulty);

    return res.status(200).json({
      success: true,
      data: {
        knownConceptsCount: knownConcepts.length,
        totalConcepts: allConcepts.length,
        suggestions: enrichedSuggestions.slice(0, 10), // Return top 10 suggestions
      },
    });
  } catch (error) {
    console.error('Error getting learning path suggestions:', error);
    return res.status(500).json({
      error: 'Failed to get learning path suggestions',
      details: error.message,
    });
  }
};

/**
 * Search concepts by name or description
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const searchConcepts = async (req, res) => {
  try {
    const { q: query, limit = 20 } = req.query;
    const { user } = req;
    const userId = user.id;

    if (!query || query.trim().length < 2) {
      return res.status(400).json({
        error:
          'Query parameter "q" is required and must be at least 2 characters long',
      });
    }

    const searchResults = curriculumService.searchConcepts(query.trim());

    // If user is authenticated, include their proficiency state for each concept
    if (userId && searchResults.length > 0) {
      const conceptIds = searchResults.map((result) => result.id);
      const userStates = await proficiencyService.getCurrentUserStates(
        userId,
        conceptIds,
      );

      searchResults.forEach((result) => {
        // eslint-disable-next-line no-param-reassign
        result.userProficiency = userStates[result.id] || {
          bloomLevel: '0_unseen',
          misconceptionFlag: false,
          lastEvidence: null,
          lastUpdated: null,
        };
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        query: query.trim(),
        results: searchResults.slice(0, parseInt(limit, 10)),
      },
    });
  } catch (error) {
    console.error('Error searching concepts:', error);
    return res.status(500).json({
      error: 'Failed to search concepts',
      details: error.message,
    });
  }
};

/**
 * Get curriculum structure overview
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getCurriculumOverview = async (req, res) => {
  try {
    const { includeDetails = false } = req.query;
    const curriculum = curriculumService.getAllConcepts();

    if (includeDetails === 'true') {
      return res.status(200).json({
        success: true,
        data: {
          totalConcepts: Object.keys(curriculum).length,
          rootConcepts: curriculumService.getRootConcepts(),
          leafConcepts: curriculumService.getLeafConcepts(),
          bloomLevels: curriculumService.getBloomLevels(),
          concepts: curriculum,
        },
      });
    }

    // Return just overview without full concept details
    const overview = {};
    Object.keys(curriculum).forEach((conceptId) => {
      const concept = curriculum[conceptId];
      overview[conceptId] = {
        name: concept.name,
        description: concept.description,
        prerequisiteCount: concept.prerequisites?.length || 0,
        childrenCount: concept.children?.length || 0,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        totalConcepts: Object.keys(curriculum).length,
        rootConcepts: curriculumService.getRootConcepts(),
        leafConcepts: curriculumService.getLeafConcepts(),
        bloomLevels: curriculumService.getBloomLevels(),
        concepts: overview,
      },
    });
  } catch (error) {
    console.error('Error getting curriculum overview:', error);
    return res.status(500).json({
      error: 'Failed to get curriculum overview',
      details: error.message,
    });
  }
};

/**
 * Get concepts by category/type
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getConceptsByCategory = async (req, res) => {
  try {
    const { category } = req.params;
    const { user } = req;
    const userId = user?.id;

    const matchingConcepts = curriculumService.getConceptsByCategory(category);

    if (matchingConcepts.length === 0) {
      return res.status(404).json({
        error: 'No concepts found for category',
        category,
      });
    }

    // Get concept details
    const conceptsWithDetails = matchingConcepts.map((conceptId) => {
      const concept = curriculumService.getConcept(conceptId);
      return {
        id: conceptId,
        name: concept.name,
        description: concept.description,
        prerequisites: concept.prerequisites || [],
        children: concept.children || [],
        examples: concept.examples || [],
      };
    });

    // If user is authenticated, include proficiency states
    if (userId) {
      const userStates = await proficiencyService.getCurrentUserStates(
        userId,
        matchingConcepts,
      );
      conceptsWithDetails.forEach((concept) => {
        // eslint-disable-next-line no-param-reassign
        concept.userProficiency = userStates[concept.id];
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        category,
        count: conceptsWithDetails.length,
        concepts: conceptsWithDetails,
      },
    });
  } catch (error) {
    console.error('Error getting concepts by category:', error);
    return res.status(500).json({
      error: 'Failed to get concepts by category',
      details: error.message,
    });
  }
};

module.exports = {
  getUserProficiencySummary,
  getUserProficiencyDetails,
  getConceptProficiency,
  getLearningPathSuggestions,
  searchConcepts,
  getCurriculumOverview,
  getConceptsByCategory,
};
