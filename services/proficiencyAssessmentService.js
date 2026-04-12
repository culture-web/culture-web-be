const supabase = require('../client/supabaseClient');
const huggingFaceClient = require('../client/huggingfaceClient');
const CurriculumService = require('./curriculumService');

/**
 * Proficiency Assessment Service
 * Analyzes user messages and determines proficiency state transitions
 * Implements the "Sticky-Progress Assessment" logic
 */
class ProficiencyAssessmentService {
  constructor() {
    this.curriculumService = new CurriculumService();
    this.client = null; // Lazy initialization
  }

  /**
   * Get the HuggingFace client, initializing it if needed
   * @returns {Object} HuggingFace client instance
   */
  getClient() {
    if (!this.client) {
      this.client = huggingFaceClient.getInstance();
    }
    return this.client;
  }

  /**
   * Main method to assess user proficiency based on their message
   * @param {string} userId - User identifier
   * @param {string} userMessage - User's message content
   * @param {string} sessionId - Chat session ID for context
   * @returns {Promise<Array>} Array of proficiency updates
   */
  async assessUserProficiency(userId, userMessage) {
    try {
      console.log(
        `🎯 [ProficiencyAssessment] Starting assessment for user: ${userId}`,
      );

      // Step 1: Find relevant concepts from the user message
      const relevantConcepts =
        this.curriculumService.findRelevantConcepts(userMessage);

      if (relevantConcepts.length === 0) {
        console.log(
          '📝 [ProficiencyAssessment] No relevant concepts found in message',
        );
        return [];
      }

      console.log(
        `🔍 [ProficiencyAssessment] Found ${relevantConcepts.length} relevant concepts: ${relevantConcepts.slice(0, 3).join(', ')}`,
      );

      // Step 2: Get current user proficiency states for relevant concepts
      const currentStates = await this.getCurrentUserStates(
        userId,
        relevantConcepts,
      );

      // Step 3: Analyze user message against the entire curriculum using AI
      // Let AI determine which concepts are actually relevant and assess proficiency
      const analysisResult = await this.analyzeMessageForAllConcepts(
        userMessage,
        relevantConcepts,
        currentStates,
      );

      console.log(
        `✅ [ProficiencyAssessment] Generated ${analysisResult.length} proficiency updates`,
      );
      return analysisResult;
    } catch (error) {
      console.error('❌ [ProficiencyAssessment] Error in assessment:', error);
      return [];
    }
  }

  /**
   * Get current user proficiency states for given concepts
   * @param {string} userId - User identifier
   * @param {Array} conceptIds - Array of concept IDs
   * @returns {Promise<Object>} Object mapping concept IDs to current states
   */
  async getCurrentUserStates(userId, conceptIds) {
    const states = {};

    try {
      const { data, error } = await supabase
        .from('user_proficiency_state')
        .select(
          'node_id, bloom_level, misconception_flag, last_evidence, last_reasoning, last_confidence, updated_at',
        )
        .eq('user_id', userId)
        .in('node_id', conceptIds);

      if (error) {
        throw error;
      }

      data.forEach((row) => {
        states[row.node_id] = {
          bloomLevel: row.bloom_level,
          misconceptionFlag: row.misconception_flag,
          lastEvidence: row.last_evidence,
          lastReasoning: row.last_reasoning,
          lastConfidence: row.last_confidence,
          lastUpdated: row.updated_at,
        };
      });

      // Fill in default states for concepts not in database
      conceptIds.forEach((conceptId) => {
        if (!states[conceptId]) {
          states[conceptId] = {
            bloomLevel: '0_unseen',
            misconceptionFlag: false,
            lastEvidence: null,
            lastReasoning: null,
            lastConfidence: null,
            lastUpdated: null,
          };
        }
      });
    } catch (error) {
      console.error(
        '❌ [ProficiencyAssessment] Error fetching current states:',
        error,
      );
    }

    return states;
  }

  /**
   * Use AI to analyze user's message against the entire curriculum
   * @param {string} userMessage - User's message
   * @param {Array} allConceptIds - All concept IDs from curriculum
   * @param {Object} currentStates - Current proficiency states
   * @param {string} sessionId - Session ID for additional context
   * @returns {Promise<Array>} Array of proficiency updates
   */
  async analyzeMessageForAllConcepts(
    userMessage,
    allConceptIds,
    currentStates,
  ) {
    try {
      const systemPrompt = this.buildComprehensiveAnalysisPrompt(
        allConceptIds,
        currentStates,
      );

      const messages = [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: `User message: "${userMessage}"`,
        },
      ];

      console.log(
        `🤖 [ProficiencyAssessment] Analyzing message against full curriculum`,
      );

      const response = await this.getClient().chatCompletion({
        provider: 'together',
        model: 'openai/gpt-oss-120b',
        messages: messages,
        temperature: 0.1, // Low temperature for consistent analysis
      });

      const aiResponse = response.choices[0].message.content;
      console.log(
        `🤖 [ProficiencyAssessment] AI Response length: ${aiResponse.length} chars`,
      );
      console.log(
        `🤖 [ProficiencyAssessment] AI Response preview: ${aiResponse.substring(0, 500)}...`,
      );
      console.log(`🤖 [ProficiencyAssessment] FULL AI RESPONSE:`);
      console.log(`${aiResponse}`);
      console.log(`🤖 [ProficiencyAssessment] END OF AI RESPONSE`);

      return this.parseComprehensiveAnalysisResponse(
        aiResponse,
        userMessage,
        currentStates,
      );
    } catch (error) {
      console.error(
        `❌ [ProficiencyAssessment] Error in comprehensive analysis:`,
        error,
      );
      return [];
    }
  }

  /**
   * Build the AI prompt for analyzing against the full curriculum
   * @param {Array} allConceptIds - All concept IDs
   * @param {Object} currentStates - Current user states
   * @returns {string} System prompt for comprehensive analysis
   */
  buildComprehensiveAnalysisPrompt(allConceptIds, currentStates) {
    const allConcepts = this.curriculumService.getAllConcepts();

    // Build simplified curriculum context with all concepts
    const curriculumContext = allConceptIds
      .map((conceptId) => {
        const concept = allConcepts[conceptId];
        const currentState = currentStates[conceptId];
        return `${conceptId}: ${concept.name} (Current: ${currentState.bloomLevel})`;
      })
      .join('\n');

    console.log(
      `🎓 [ProficiencyAssessment] Building prompt with ${allConceptIds.length} concepts`,
    );
    console.log(
      `📏 [ProficiencyAssessment] Curriculum context length: ${curriculumContext.length} chars`,
    );

    return `You are assessing Kathakali knowledge proficiency.

RELEVANT CONCEPTS:
${curriculumContext}

LEVELS: 0_unseen, 1_remember, 2_understand, 3_apply, 4_analyze

TASK: Analyze if the user message shows knowledge of any concept above. Be generous - if they mention or ask about a concept, assess their level.

EXAMPLES:
- User asks "What is paccha?" → paccha_characters: 1_remember (they're learning about it)
- User says "Paccha characters are noble heroes" → paccha_characters: 2_understand
- User discusses character relationships → higher levels

OUTPUT JSON ARRAY (be generous, not overly conservative):
[
  {
    "concept_id": "conceptId", 
    "new_level": "1_remember",
    "misconception_flag": false,
    "evidence": "quote from message",
    "reasoning": "brief reason",
    "confidence": 0.8
  }
]

Return [] only if message is completely unrelated to Kathakali.`;
  }

  /**
   * Parse comprehensive AI analysis response
   * @param {string} aiResponse - AI's analysis response
   * @param {string} originalMessage - Original user message
   * @param {Object} currentStates - Current user states
   * @returns {Array} Array of proficiency updates
   */
  parseComprehensiveAnalysisResponse(
    aiResponse,
    originalMessage,
    currentStates,
  ) {
    try {
      // Try to extract JSON array from the response
      const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.log(
          '📝 [ProficiencyAssessment] No JSON array found in AI response',
        );
        console.log(
          `🔍 [ProficiencyAssessment] Full AI response: ${aiResponse}`,
        );
        return [];
      }

      console.log(
        `🔍 [ProficiencyAssessment] Found JSON match: ${jsonMatch[0]}`,
      );
      const assessments = JSON.parse(jsonMatch[0]);

      if (!Array.isArray(assessments)) {
        console.warn('❌ [ProficiencyAssessment] Response not an array');
        console.log(
          `🔍 [ProficiencyAssessment] Parsed result type: ${typeof assessments}`,
        );
        return [];
      }

      console.log(
        `✅ [ProficiencyAssessment] Parsed ${assessments.length} assessments from AI`,
      );
      const proficiencyUpdates = [];
      const validLevels = [
        '0_unseen',
        '1_remember',
        '2_understand',
        '3_apply',
        '4_analyze',
      ];

      assessments.forEach((assessment, index) => {
        console.log(
          `🔍 [ProficiencyAssessment] Processing assessment ${index + 1}:`,
          assessment,
        );

        // Validate assessment structure
        if (
          !assessment.concept_id ||
          !assessment.new_level ||
          assessment.confidence === undefined
        ) {
          console.warn(
            `❌ [ProficiencyAssessment] Invalid assessment structure at index ${index}:`,
            assessment,
          );
          return;
        }

        // Validate bloom level
        if (!validLevels.includes(assessment.new_level)) {
          console.warn(
            `❌ [ProficiencyAssessment] Invalid bloom level: ${assessment.new_level} at index ${index}`,
          );
          return;
        }

        // Check confidence threshold
        if (assessment.confidence < 0.6) {
          console.log(
            `⚠️ [ProficiencyAssessment] Low confidence (${assessment.confidence}) for ${assessment.concept_id}, skipping`,
          );
          return;
        }

        const currentState = currentStates[assessment.concept_id];
        console.log(
          `🎯 [ProficiencyAssessment] Current state for ${assessment.concept_id}:`,
          currentState,
        );

        const shouldUpdate = this.shouldUpdateProficiency(currentState, {
          newLevel: assessment.new_level,
          misconceptionFlag: assessment.misconception_flag,
          confidence: assessment.confidence,
        });

        console.log(
          `🤔 [ProficiencyAssessment] Should update ${assessment.concept_id}? ${shouldUpdate}`,
        );

        if (shouldUpdate) {
          proficiencyUpdates.push({
            conceptId: assessment.concept_id,
            newLevel: assessment.new_level,
            misconceptionFlag: assessment.misconception_flag || false,
            evidence: assessment.evidence || originalMessage.substring(0, 500),
            reasoning: assessment.reasoning || 'AI assessment',
            confidence: Math.max(0.6, Math.min(1.0, assessment.confidence)),
            previousState: currentState,
          });
        }
      });

      return proficiencyUpdates;
    } catch (error) {
      console.error(
        '❌ [ProficiencyAssessment] Error parsing comprehensive analysis:',
        error,
      );
      return [];
    }
  }

  /**
   * Determine if proficiency should be updated based on analysis
   * @param {Object} currentState - Current user state
   * @param {Object} analysisResult - AI analysis result
   * @returns {boolean} True if update should be applied
   */
  shouldUpdateProficiency(currentState, analysisResult) {
    console.log(`🔍 [ProficiencyAssessment] Checking update conditions:`);
    console.log(
      `   Current: ${currentState.bloomLevel}, New: ${analysisResult.newLevel}`,
    );
    console.log(
      `   Confidence: ${analysisResult.confidence}, Misconception: ${analysisResult.misconceptionFlag}`,
    );

    // Only update if confidence is high enough
    if (analysisResult.confidence < 0.6) {
      console.log(
        `⚠️ [ProficiencyAssessment] Low confidence (${analysisResult.confidence}), skipping update`,
      );
      return false;
    }

    const currentLevel = this.bloomLevelToNumber(currentState.bloomLevel);
    const newLevel = this.bloomLevelToNumber(analysisResult.newLevel);

    console.log(
      `📊 [ProficiencyAssessment] Level numbers - Current: ${currentLevel}, New: ${newLevel}`,
    );

    // Apply sticky progress logic with misconception blocking
    if (newLevel < currentLevel && !analysisResult.misconceptionFlag) {
      console.log(
        `🛡️ [ProficiencyAssessment] Sticky progress: preventing downgrade from ${currentState.bloomLevel} to ${analysisResult.newLevel}`,
      );
      return false;
    }

    // If misconception detected, prevent level upgrades but allow flag updates
    if (analysisResult.misconceptionFlag && newLevel > currentLevel) {
      console.log(
        `🚫 [ProficiencyAssessment] Misconception detected: blocking level upgrade from ${currentState.bloomLevel} to ${analysisResult.newLevel}`,
      );
      // Still allow misconception flag update without level change
      return newLevel === currentLevel;
    }

    const shouldUpdate =
      newLevel > currentLevel ||
      analysisResult.misconceptionFlag ||
      newLevel === currentLevel;

    console.log(`✅ [ProficiencyAssessment] Update decision: ${shouldUpdate}`);
    return shouldUpdate;
  }

  /**
   * Convert bloom level enum to number for comparison
   * @param {string} bloomLevel - Bloom level enum
   * @returns {number} Numeric level
   */
  bloomLevelToNumber(bloomLevel) {
    const levelMap = {
      '0_unseen': 0,
      '1_remember': 1,
      '2_understand': 2,
      '3_apply': 3,
      '4_analyze': 4,
    };
    return levelMap[bloomLevel] || 0;
  }

  /**
   * Apply proficiency updates to database
   * @param {string} userId - User identifier
   * @param {Array} updates - Array of proficiency updates
   * @returns {Promise<void>}
   */
  /**
   * Public method to unlock neighbors for a list of updated concepts
   * @param {string} userId - User identifier
   * @param {Array} updatedConcepts - Array of {conceptId, newLevel, newLevelNumber}
   */
  async checkAndUnlockNeighbors(userId, updatedConcepts) {
    await this.unlockNeighborConcepts(userId, updatedConcepts);
  }

  /**
   * Unlock neighbor concepts when a concept reaches level 2 or higher
   * @param {string} userId - User identifier
   * @param {Array} updatedConcepts - Array of updated concepts with new levels
   */
  async unlockNeighborConcepts(userId, updatedConcepts) {
    try {
      // Find concepts that reached level 2 or higher
      const qualifiedConcepts = updatedConcepts.filter(
        (update) => update.newLevelNumber >= 2, // 2_understand or higher
      );

      if (qualifiedConcepts.length === 0) {
        return; // No concepts qualified for unlocking
      }

      console.log(
        `🔓 [ProficiencyAssessment] Checking neighbor unlocking for ${qualifiedConcepts.length} qualified concepts`,
      );

      const conceptsToUnlock = new Set();

      // For each qualified concept, get its neighbors
      qualifiedConcepts.forEach((update) => {
        const neighbors = this.getNeighborConcepts(update.conceptId);
        neighbors.forEach((neighborId) => {
          conceptsToUnlock.add(neighborId);
        });
      });

      if (conceptsToUnlock.size === 0) {
        return; // No neighbors to unlock
      }

      console.log(
        `🔓 [ProficiencyAssessment] Found ${conceptsToUnlock.size} neighbor concepts to potentially unlock`,
      );

      // Check which neighbors don't have proficiency states yet
      const { data: existingStates, error } = await supabase
        .from('user_proficiency_state')
        .select('node_id')
        .eq('user_id', userId)
        .in('node_id', Array.from(conceptsToUnlock));

      if (error) {
        console.error(
          '❌ [ProficiencyAssessment] Error checking existing states for neighbors:',
          error,
        );
        return;
      }

      const existingConceptIds = new Set(
        (existingStates || []).map((state) => state.node_id),
      );

      const newConceptsToUnlock = Array.from(conceptsToUnlock).filter(
        (conceptId) => !existingConceptIds.has(conceptId),
      );

      if (newConceptsToUnlock.length === 0) {
        console.log(
          `🔓 [ProficiencyAssessment] All neighbor concepts already unlocked`,
        );
        return;
      }

      console.log(
        `🔓 [ProficiencyAssessment] Unlocking ${newConceptsToUnlock.length} new neighbor concepts`,
      );

      // Create proficiency states for new concepts
      const unlockInserts = newConceptsToUnlock.map((conceptId) => ({
        user_id: userId,
        node_id: conceptId,
        bloom_level: '0_unseen',
        misconception_flag: false,
        last_evidence: 'Unlocked as neighbor of advanced concept',
        last_reasoning:
          'Concept unlocked due to progression in prerequisite knowledge',
        last_confidence: 0.0,
        updated_at: new Date().toISOString(),
      }));

      const { error: insertError } = await supabase
        .from('user_proficiency_state')
        .insert(unlockInserts);

      if (insertError) {
        console.error(
          '❌ [ProficiencyAssessment] Error unlocking neighbor concepts:',
          insertError,
        );
      } else {
        console.log(
          `✅ [ProficiencyAssessment] Successfully unlocked concepts: ${newConceptsToUnlock.join(', ')}`,
        );
      }
    } catch (error) {
      console.error(
        '❌ [ProficiencyAssessment] Error in unlockNeighborConcepts:',
        error,
      );
    }
  }

  /**
   * Get neighbor concepts (children and prerequisites) for a given concept
   * @param {string} conceptId - The concept identifier
   * @returns {Array} Array of neighbor concept IDs
   */
  getNeighborConcepts(conceptId) {
    const neighbors = new Set();

    // Add children (concepts that depend on this one)
    const children = this.curriculumService.getChildren(conceptId);
    children.forEach((childId) => neighbors.add(childId));

    // Add prerequisites (concepts this one depends on)
    // This ensures that even if prerequisites weren't encountered in chat,
    // they become discoverable when the user masters a central/advanced concept
    const prerequisites = this.curriculumService.getPrerequisites(conceptId);
    prerequisites.forEach((prereqId) => neighbors.add(prereqId));

    return Array.from(neighbors);
  }

  async applyProficiencyUpdates(userId, updates) {
    if (!updates || updates.length === 0) {
      return;
    }

    try {
      console.log(
        `💾 [ProficiencyAssessment] Applying ${updates.length} updates for user: ${userId}`,
      );

      const updatedConcepts = [];

      await Promise.all(
        updates.map(async (update) => {
          // Use upsert to implement sticky progress logic
          const { data: existingState } = await supabase
            .from('user_proficiency_state')
            .select('bloom_level, misconception_flag')
            .eq('user_id', userId)
            .eq('node_id', update.conceptId)
            .single();

          const currentLevel = this.bloomLevelToNumber(
            existingState?.bloom_level || '0_unseen',
          );
          const newLevel = this.bloomLevelToNumber(update.newLevel);

          // Apply sticky progress logic
          const shouldUpdate =
            newLevel > currentLevel ||
            update.misconceptionFlag ||
            !existingState;

          if (shouldUpdate) {
            const { error } = await supabase
              .from('user_proficiency_state')
              .upsert(
                {
                  user_id: userId,
                  node_id: update.conceptId,
                  bloom_level: update.newLevel,
                  misconception_flag:
                    update.misconceptionFlag ||
                    existingState?.misconception_flag ||
                    false,
                  last_evidence: update.evidence,
                  last_reasoning: update.reasoning,
                  last_confidence: update.confidence,
                  updated_at: new Date().toISOString(),
                },
                {
                  onConflict: 'user_id,node_id',
                },
              );

            if (error) {
              throw error;
            }

            console.log(
              `✅ [ProficiencyAssessment] Updated ${update.conceptId}: ${existingState?.bloom_level || '0_unseen'} → ${update.newLevel}`,
            );

            // Track updated concepts for neighbor unlocking
            updatedConcepts.push({
              conceptId: update.conceptId,
              newLevel: update.newLevel,
              newLevelNumber: newLevel,
            });
          } else {
            console.log(
              `🛡️ [ProficiencyAssessment] Skipped update for ${update.conceptId} (sticky progress)`,
            );
          }
        }),
      );

      // Check for neighbor unlocking after all updates
      await this.unlockNeighborConcepts(userId, updatedConcepts);
    } catch (error) {
      console.error(
        '❌ [ProficiencyAssessment] Error applying updates:',
        error,
      );
      throw error;
    }
  }

  /**
   * Get user's overall proficiency summary
   * @param {string} userId - User identifier
   * @returns {Promise<Object>} Proficiency summary
   */
  async getUserProficiencySummary(userId) {
    try {
      const { data, error } = await supabase
        .from('user_proficiency_state')
        .select('bloom_level, misconception_flag, updated_at')
        .eq('user_id', userId);

      if (error) {
        throw error;
      }

      if (!data || data.length === 0) {
        return {
          total_concepts: 0,
          concepts_learned: 0,
          misconceptions_count: 0,
          average_proficiency_level: 0,
          last_activity: null,
        };
      }

      const totalConcepts = data.length;
      const conceptsLearned = data.filter(
        (row) => row.bloom_level !== '0_unseen',
      ).length;
      const misconceptionsCount = data.filter(
        (row) => row.misconception_flag,
      ).length;

      const avgLevel =
        data.reduce(
          (sum, row) => sum + this.bloomLevelToNumber(row.bloom_level),
          0,
        ) / totalConcepts;

      const lastActivity = data.reduce((latest, row) => {
        const updated = new Date(row.updated_at);
        return !latest || updated > latest ? updated : latest;
      }, null);

      return {
        total_concepts: totalConcepts,
        concepts_learned: conceptsLearned,
        misconceptions_count: misconceptionsCount,
        average_proficiency_level: avgLevel,
        last_activity: lastActivity,
      };
    } catch (error) {
      console.error('❌ [ProficiencyAssessment] Error getting summary:', error);
      throw error;
    }
  }
}

module.exports = ProficiencyAssessmentService;
