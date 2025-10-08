const preprocessChatResponse = (rawResponse) => {
  try {
    const response = {
      shortAnswer: '',
      reasoning: null,
      sections: [],
      tables: [],
      metadata: {
        hasStructuredContent: false,
        responseLength: rawResponse.length,
        processingTimestamp: new Date().toISOString(),
      },
    };

    // Clean and normalize the response
    const cleanResponse = rawResponse.trim();

    // Extract short answer (content before first header or separator)
    const shortAnswerMatch = cleanResponse.match(/^\*\*([^*]+):\*\*\s*([\s\S]*?)(?=\n\s*---|\n\s*###|\n\s*\||\n\s*\*\*[^*]+\*\*|$)/);
    
    if (shortAnswerMatch) {
      response.shortAnswer = shortAnswerMatch[2].trim();
    } else {
      // Try alternative patterns for bold text
      const altBoldMatch = cleanResponse.match(/^\*\*([^*]+)\*\*\s*([\s\S]*?)(?=\n\s*---|\n\s*###|\n\s*\||\n\s*\*\*[^*]+\*\*|$)/);
      
      if (altBoldMatch) {
        response.shortAnswer = altBoldMatch[2].trim();
      } else {
        // Fallback: use first paragraph or sentence
        const firstParagraph = cleanResponse.split(/\n\s*\n/)[0];
        response.shortAnswer = firstParagraph.length > 200 
          ? firstParagraph.substring(0, 200) + '...' 
          : firstParagraph;
      }
    }

    // Extract sections based on headers (###, ####, etc.)
    const sectionMatches = cleanResponse.match(/###[^#].*?(?=\n###|$)/gs);
    if (sectionMatches) {
      response.sections = sectionMatches.map((section) => {
        const lines = section.split('\n');
        const title = lines[0].replace(/^#+\s*/, '').trim();
        const content = lines.slice(1).join('\n').trim();
        return { title, content };
      });
      response.metadata.hasStructuredContent = true;
    }

    // Extract tables
    const tableMatches = cleanResponse.match(/\|.*\|[\s\S]*?(?=\n\s*\n|\n\s*###|$)/g);
    if (tableMatches) {
      response.tables = tableMatches.map((tableText, index) => {
        const lines = tableText.trim().split('\n').filter(line => line.includes('|'));
        
        if (lines.length < 2) return null;
        
        // Extract headers
        const headers = lines[0]
          .split('|')
          .map(cell => cell.trim())
          .filter(cell => cell !== '');
        
        // Skip separator line and extract rows
        const rows = lines.slice(2).map(line => 
          line.split('|')
            .map(cell => cell.trim())
            .filter(cell => cell !== '')
        );
        
        return {
          id: `table_${index + 1}`,
          headers,
          rows,
          title: `Table ${index + 1}`,
        };
      }).filter(table => table !== null);
      
      if (response.tables.length > 0) {
        response.metadata.hasStructuredContent = true;
      }
    }

    // If no structured content found, put everything in reasoning
    if (!response.metadata.hasStructuredContent) {
      const parts = cleanResponse.split(/\n\s*\n/);
      if (parts.length > 1) {
        response.shortAnswer = parts[0];
        response.reasoning = parts.slice(1).join('\n\n');
      } else {
        response.shortAnswer = cleanResponse;
      }
    } else {
      // Extract remaining content as reasoning
      let remainingContent = cleanResponse;
      
      // Remove short answer section
      if (shortAnswerMatch) {
        remainingContent = remainingContent.replace(shortAnswerMatch[0], '').trim();
      }
      
      // Remove sections
      if (sectionMatches) {
        sectionMatches.forEach(section => {
          remainingContent = remainingContent.replace(section, '').trim();
        });
      }
      
      // Remove tables
      if (tableMatches) {
        tableMatches.forEach(table => {
          remainingContent = remainingContent.replace(table, '').trim();
        });
      }
      
      // Clean up separators and extra whitespace
      remainingContent = remainingContent
        .replace(/---+/g, '')
        .replace(/\n\s*\n\s*\n/g, '\n\n')
        .trim();
      
      if (remainingContent) {
        response.reasoning = remainingContent;
      }
    }

    // Clean up short answer - only remove bold markdown formatting
    response.shortAnswer = response.shortAnswer
      .replace(/^\*\*[^*]+:\*\*\s*/, '') // Remove bold headers with colon
      .replace(/^\*\*[^*]+\*\*\s*/, '') // Remove bold headers without colon
      .trim();

    return response;
  } catch (error) {
    // Fallback to simple format
    return {
      shortAnswer: rawResponse.length > 200 ? rawResponse.substring(0, 200) + '...' : rawResponse,
      reasoning: rawResponse.length > 200 ? rawResponse : null,
      sections: [],
      tables: [],
      metadata: {
        hasStructuredContent: false,
        responseLength: rawResponse.length,
        processingTimestamp: new Date().toISOString(),
        error: 'Preprocessing failed, using fallback format',
      },
    };
  }
};

module.exports = {
  preprocessChatResponse,
};
