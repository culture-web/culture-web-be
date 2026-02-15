const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Curriculum Service for Managing the Kathakali Knowledge Graph
 * Loads and provides access to the static curriculum structure
 */
class CurriculumService {
  constructor() {
    this.curriculum = null;
    this.bloomLevels = null;
    this.misconceptions = null;
    this.loadCurriculum();
  }

  /**
   * Load the curriculum YAML file
   */
  loadCurriculum() {
    try {
      const curriculumPath = path.join(__dirname, '../curriculum.yaml');
      const fileContents = fs.readFileSync(curriculumPath, 'utf8');
      const data = yaml.load(fileContents);
      
      this.curriculum = data.curriculum;
      this.bloomLevels = data.bloom_levels;
      this.misconceptions = data.common_misconceptions;
      
      console.log(`✅ [CurriculumService] Loaded ${Object.keys(this.curriculum).length} curriculum concepts`);
    } catch (error) {
      console.error('❌ [CurriculumService] Failed to load curriculum:', error);
      throw new Error(`Failed to load curriculum: ${error.message}`);
    }
  }

  /**
   * Get all curriculum concepts
   * @returns {Object} Complete curriculum structure
   */
  getAllConcepts() {
    return this.curriculum;
  }

  /**
   * Get a specific concept by ID
   * @param {string} conceptId - The concept identifier
   * @returns {Object|null} Concept data or null if not found
   */
  getConcept(conceptId) {
    return this.curriculum[conceptId] || null;
  }

  /**
   * Get prerequisites for a concept
   * @param {string} conceptId - The concept identifier
   * @returns {Array} Array of prerequisite concept IDs
   */
  getPrerequisites(conceptId) {
    const concept = this.getConcept(conceptId);
    return concept ? concept.prerequisites || [] : [];
  }

  /**
   * Get children concepts for a concept
   * @param {string} conceptId - The concept identifier
   * @returns {Array} Array of child concept IDs
   */
  getChildren(conceptId) {
    const concept = this.getConcept(conceptId);
    return concept ? concept.children || [] : [];
  }

  /**
   * Get all root concepts (concepts with no prerequisites)
   * @returns {Array} Array of root concept IDs
   */
  getRootConcepts() {
    return Object.keys(this.curriculum).filter(conceptId => {
      const concept = this.curriculum[conceptId];
      return !concept.prerequisites || concept.prerequisites.length === 0;
    });
  }

  /**
   * Get all leaf concepts (concepts with no children)
   * @returns {Array} Array of leaf concept IDs
   */
  getLeafConcepts() {
    return Object.keys(this.curriculum).filter(conceptId => {
      const concept = this.curriculum[conceptId];
      return !concept.children || concept.children.length === 0;
    });
  }

  /**
   * Check if a concept exists
   * @param {string} conceptId - The concept identifier
   * @returns {boolean} True if concept exists
   */
  conceptExists(conceptId) {
    return this.curriculum.hasOwnProperty(conceptId);
  }

  /**
   * Get concepts by category/type based on naming patterns
   * @param {string} category - Category pattern to match
   * @returns {Array} Array of matching concept IDs
   */
  getConceptsByCategory(category) {
    return Object.keys(this.curriculum).filter(conceptId => 
      conceptId.includes(category) || 
      this.curriculum[conceptId].name.toLowerCase().includes(category.toLowerCase())
    );
  }

  /**
   * Search concepts by name or description
   * @param {string} searchTerm - Term to search for
   * @returns {Array} Array of matching concept objects with IDs
   */
  searchConcepts(searchTerm) {
    const term = searchTerm.toLowerCase();
    return Object.keys(this.curriculum)
      .filter(conceptId => {
        const concept = this.curriculum[conceptId];
        return conceptId.toLowerCase().includes(term) ||
               concept.name.toLowerCase().includes(term) ||
               concept.description.toLowerCase().includes(term);
      })
      .map(conceptId => ({
        id: conceptId,
        ...this.curriculum[conceptId]
      }));
  }

  /**
   * Find concepts that are likely related to a user's message
   * 
   * TODO: As the curriculum DAG grows larger, we should:
   * 1. Store the curriculum concepts in a vector database (embeddings)
   * 2. Query for semantically relevant concepts based on user message
   * 3. Include prerequisites and dependencies of relevant concepts
   * 4. This will provide better scalability and semantic understanding
   * 
   * For now, we return all concepts and let the AI evaluate relevance
   * since our current curriculum is manageable in size (~50 concepts)
   * 
   * @param {string} message - User's message
   * @returns {Array} Array of all concept IDs (AI will determine relevance)
   */
  findRelevantConcepts(message) {
    // For now, return all concepts and let AI determine relevance
    // This is feasible with our current curriculum size (~50 concepts)
    return Object.keys(this.curriculum);
  }

  /**
   * Extract keywords from a message for concept matching
   * @param {string} message - The message to extract keywords from
   * @returns {Array} Array of relevant keywords
   */
  extractKeywords(message) {
    // Common Kathakali-related terms to look for
    const kathakaliTerms = [
      'kathakali', 'character', 'characters', 'makeup', 'costume', 'expression',
      'mudra', 'mudras', 'dance', 'performance', 'story', 'color', 'face',
      'green', 'red', 'black', 'paccha', 'kathi', 'thaadi', 'minukku', 'kari',
      'rama', 'krishna', 'ravana', 'sita', 'arjuna', 'emotion', 'anger', 'love',
      'fear', 'joy', 'sorrow', 'hero', 'villain', 'demon', 'god', 'divine',
      'ornament', 'ornaments', 'music', 'instruments', 'chenda', 'ramayana',
      'mahabharata', 'curtain', 'thirasseela', 'hand', 'gesture', 'eye',
      'movement', 'facial', 'beard', 'crown', 'dress', 'stage', 'kerala'
    ];

    const words = message.toLowerCase().match(/\b\w{3,}\b/g) || [];
    return words.filter(word => 
      kathakaliTerms.includes(word) || 
      word.length > 5 // Include longer words that might be relevant
    );
  }

  /**
   * Get all Bloom's taxonomy levels
   * @returns {Object} Bloom levels with descriptions
   */
  getBloomLevels() {
    return this.bloomLevels;
  }

  /**
   * Get common misconceptions
   * @returns {Array} Array of common misconceptions
   */
  getCommonMisconceptions() {
    return this.misconceptions;
  }

  /**
   * Validate if a concept dependency chain is valid
   * @param {Array} concepts - Array of concept IDs in order
   * @returns {boolean} True if the dependency chain is valid
   */
  validateConceptChain(concepts) {
    for (let i = 1; i < concepts.length; i++) {
      const currentConcept = concepts[i];
      const prerequisites = this.getPrerequisites(currentConcept);
      
      // Check if any of the previous concepts satisfy the prerequisites
      const previousConcepts = concepts.slice(0, i);
      const hasPrerequisite = prerequisites.some(prereq => 
        previousConcepts.includes(prereq)
      );
      
      if (prerequisites.length > 0 && !hasPrerequisite) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get suggested next concepts based on current knowledge
   * @param {Array} knownConcepts - Array of concept IDs the user knows
   * @returns {Array} Array of suggested next concept IDs
   */
  getSuggestedNextConcepts(knownConcepts) {
    const suggestions = new Set();

    knownConcepts.forEach(conceptId => {
      const children = this.getChildren(conceptId);
      children.forEach(childId => {
        const childPrereqs = this.getPrerequisites(childId);
        // Check if all prerequisites are satisfied
        const allPrereqsMet = childPrereqs.every(prereq => 
          knownConcepts.includes(prereq)
        );
        
        if (allPrereqsMet && !knownConcepts.includes(childId)) {
          suggestions.add(childId);
        }
      });
    });

    return Array.from(suggestions);
  }
}

module.exports = CurriculumService;