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
    this.client = huggingFaceClient.getInstance();
  }

  /**
   * Main method to assess user proficiency based on their message
   * @param {string} userId - User identifier
   * @param {string} userMessage - User's message content
   * @param {string} sessionId - Chat session ID for context
   * @returns {Promise<Array>} Array of proficiency updates
   */
  async assessUserProficiency(userId, userMessage, sessionId = null) {
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
        sessionId,
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
    sessionId,
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

      const response = await this.client.chatCompletion({
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
    const bloomDescriptions = this.curriculumService.getBloomLevels();
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
   * Use AI to analyze user's proficiency for a specific concept
   * @param {string} userMessage - User's message
   * @param {string} conceptId - Concept identifier
   * @param {Object} concept - Concept data from curriculum
   * @param {Object} currentState - Current proficiency state
   * @param {string} sessionId - Session ID for additional context
   * @returns {Promise<Object>} Analysis result with new level and flags
   */
  async analyzeConceptProficiency(
    userMessage,
    conceptId,
    concept,
    currentState,
    sessionId,
  ) {
    try {
      const systemPrompt = this.buildAnalysisPrompt(
        conceptId,
        concept,
        currentState,
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

      console.log(`🤖 [ProficiencyAssessment] Analyzing concept: ${conceptId}`);

      const response = await this.client.chatCompletion({
        provider: 'together',
        model: 'openai/gpt-oss-120b',
        messages: messages,
        temperature: 0.1, // Low temperature for consistent analysis
      });

      const aiResponse = response.choices[0].message.content;
      return this.parseAnalysisResponse(aiResponse, userMessage);
    } catch (error) {
      console.error(
        `❌ [ProficiencyAssessment] Error analyzing concept ${conceptId}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Build the AI prompt for proficiency analysis
   * @param {string} conceptId - Concept identifier
   * @param {Object} concept - Concept data
   * @param {Object} currentState - Current user state
   * @returns {string} System prompt for analysis
   */
  buildAnalysisPrompt(conceptId, concept, currentState) {
    const bloomDescriptions = this.curriculumService.getBloomLevels();
    const misconceptions = this.curriculumService.getCommonMisconceptions();

    return `You are the KathakalAI Pedagogy Engine for proficiency assessment.

CONCEPT BEING ANALYZED:
- ID: ${conceptId}
- Name: ${concept.name}
- Description: ${concept.description}

CURRENT USER STATE:
- Current Level: ${currentState.bloomLevel} (${bloomDescriptions[currentState.bloomLevel] || 'Unknown'})
- Has Misconception Flag: ${currentState.misconceptionFlag}
- Last Evidence: ${currentState.lastEvidence || 'None'}

BLOOM'S TAXONOMY LEVELS:
${Object.entries(bloomDescriptions)
  .map(([level, desc]) => `- ${level}: ${desc}`)
  .join('\n')}

ASSESSMENT RULES (CRITICAL - STICKY PROGRESS):

1. **Preserve Progress Rule**: The current level is a "High Score" that should be protected.
   - If user asks simple questions but has high level (3+ apply/analyze), DO NOT downgrade
   - Assume they are clarifying details or exploring the concept further
   - Only maintain or upgrade their level

2. **Downgrade ONLY on Clear Error**: Only lower the level if user explicitly:
   - Contradicts core facts about the concept
   - Shows fundamental misunderstanding despite previously demonstrating higher knowledge
   - Makes statements that directly oppose the concept's definition
   - In this case, set misconception_flag to true

3. **Upgrade on Evidence**: Upgrade if user demonstrates:
   - New depth of understanding beyond their current level
   - Ability to apply knowledge in novel ways
   - Analysis or synthesis of concept relationships
   - Correct usage in appropriate contexts

4. **Evidence Collection**: Always note specific evidence from their message that justifies the assessment.

COMMON KATHAKALI MISCONCEPTIONS TO WATCH FOR:
${misconceptions.map((m) => `- ${m}`).join('\n')}

OUTPUT FORMAT (JSON ONLY):
{
  "new_level": "1_remember|2_understand|3_apply|4_analyze",
  "misconception_flag": true|false,
  "evidence": "Specific quote or behavior from user message that justifies this assessment",
  "reasoning": "Brief explanation of why this level was chosen",
  "confidence": 0.1-1.0
}

Analyze the user's message ONLY in relation to the specific concept above. Be conservative with upgrades and extremely careful with downgrades.`;
  }

  /**
   * Parse AI response to extract proficiency assessment
   * @param {string} aiResponse - AI's analysis response
   * @param {string} originalMessage - Original user message for evidence
   * @returns {Object|null} Parsed assessment or null if invalid
   */
  parseAnalysisResponse(aiResponse, originalMessage) {
    try {
      // Try to extract JSON from the response
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn('❌ [ProficiencyAssessment] No JSON found in AI response');
        return null;
      }

      const analysis = JSON.parse(jsonMatch[0]);

      // Validate required fields
      if (!analysis.new_level || analysis.confidence === undefined) {
        console.warn('❌ [ProficiencyAssessment] Invalid analysis format');
        return null;
      }

      // Validate bloom level
      const validLevels = [
        '0_unseen',
        '1_remember',
        '2_understand',
        '3_apply',
        '4_analyze',
      ];
      if (!validLevels.includes(analysis.new_level)) {
        console.warn(
          `❌ [ProficiencyAssessment] Invalid bloom level: ${analysis.new_level}`,
        );
        return null;
      }

      return {
        newLevel: analysis.new_level,
        misconceptionFlag: analysis.misconception_flag || false,
        evidence: analysis.evidence || originalMessage.substring(0, 500),
        reasoning: analysis.reasoning || 'AI assessment',
        confidence: Math.max(0.1, Math.min(1.0, analysis.confidence || 0.5)),
      };
    } catch (error) {
      console.error(
        '❌ [ProficiencyAssessment] Error parsing AI response:',
        error,
      );
      return null;
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

    // Apply sticky progress logic
    if (newLevel < currentLevel && !analysisResult.misconceptionFlag) {
      console.log(
        `🛡️ [ProficiencyAssessment] Sticky progress: preventing downgrade from ${currentState.bloomLevel} to ${analysisResult.newLevel}`,
      );
      return false;
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
  async applyProficiencyUpdates(userId, updates) {
    if (!updates || updates.length === 0) {
      return;
    }

    try {
      console.log(
        `💾 [ProficiencyAssessment] Applying ${updates.length} updates for user: ${userId}`,
      );

      for (const update of updates) {
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
          newLevel > currentLevel || update.misconceptionFlag || !existingState;

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
            `✅ [ProficiencyAssessment] Updated ${update.conceptId}: ${update.previousState?.bloomLevel} → ${update.newLevel}`,
          );
        } else {
          console.log(
            `🛡️ [ProficiencyAssessment] Skipped update for ${update.conceptId} (sticky progress)`,
          );
        }
      }
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
