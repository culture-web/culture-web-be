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
    let shortAnswerMatch = null;
    const boldHeaderPattern = /^\*\*([^*]+):\*\*/;
    const boldHeaderMatchResult = cleanResponse.match(boldHeaderPattern);

    if (boldHeaderMatchResult) {
      const afterHeader = cleanResponse
        .substring(boldHeaderMatchResult[0].length)
        .trim();
      const stopPatterns = ['\n---', '\n###', '\n|', '\n**'];
      let endIndex = afterHeader.length;

      stopPatterns.forEach((pattern) => {
        const patternIndex = afterHeader.indexOf(pattern);
        if (patternIndex !== -1 && patternIndex < endIndex) {
          endIndex = patternIndex;
        }
      });

      shortAnswerMatch = [
        boldHeaderMatchResult[0],
        boldHeaderMatchResult[1],
        afterHeader.substring(0, endIndex).trim(),
      ];
    }
    if (shortAnswerMatch) {
      const [, , shortAnswer] = shortAnswerMatch;
      response.shortAnswer = shortAnswer;
    } else {
      // Try alternative patterns for bold text
      const altBoldPattern = /^\*\*([^*]+)\*\*/;
      const altBoldHeaderMatchResult = cleanResponse.match(altBoldPattern);

      if (altBoldHeaderMatchResult) {
        const afterHeader = cleanResponse
          .substring(altBoldHeaderMatchResult[0].length)
          .trim();
        const stopPatterns = ['\n---', '\n###', '\n|', '\n**'];
        let endIndex = afterHeader.length;

        stopPatterns.forEach((pattern) => {
          const patternIndex = afterHeader.indexOf(pattern);
          if (patternIndex !== -1 && patternIndex < endIndex) {
            endIndex = patternIndex;
          }
        });

        response.shortAnswer = afterHeader.substring(0, endIndex).trim();
      } else {
        // Fallback: use first paragraph or sentence
        const firstParagraph = cleanResponse.split(/\n\s*\n/)[0];
        response.shortAnswer =
          firstParagraph.length > 200
            ? `${firstParagraph.substring(0, 200)}...`
            : firstParagraph;
      }
    }

    // Extract sections based on headers (###, ####, etc.)
    const sectionMatches = [];
    const responseLines = cleanResponse.split('\n');
    let currentSection = null;

    responseLines.forEach((line) => {
      if (line.startsWith('###')) {
        // Save previous section if exists
        if (currentSection) {
          sectionMatches.push(currentSection.join('\n'));
        }
        // Start new section
        currentSection = [line];
      } else if (currentSection) {
        // Add line to current section
        currentSection.push(line);
      }
    });

    // Add the last section if exists
    if (currentSection) {
      sectionMatches.push(currentSection.join('\n'));
    }

    if (sectionMatches.length > 0) {
      response.sections = sectionMatches.map((section) => {
        const sectionLines = section.split('\n');
        const title = sectionLines[0].replace(/^#+\s*/, '').trim();
        const content = sectionLines.slice(1).join('\n').trim();
        return { title, content };
      });
      response.metadata.hasStructuredContent = true;
    }

    // Extract tables
    const tableMatches = [];
    const tableLines = cleanResponse.split('\n');
    let currentTable = [];
    let inTable = false;

    tableLines.forEach((line, index) => {
      const isTableLine = line.includes('|') && line.trim().length > 0;
      const nextLine = tableLines[index + 1];
      const isEndOfInput = index === tableLines.length - 1;
      const isEmptyLine = line.trim() === '';
      const isHeaderLine = nextLine && nextLine.startsWith('###');

      if (isTableLine && !inTable) {
        // Start of a new table
        inTable = true;
        currentTable = [line];
      } else if (isTableLine && inTable) {
        // Continue current table
        currentTable.push(line);
      } else if (inTable && (isEmptyLine || isHeaderLine || isEndOfInput)) {
        // End of current table
        if (currentTable.length > 0) {
          tableMatches.push(currentTable.join('\n'));
        }
        currentTable = [];
        inTable = false;
      }
    });

    // Handle case where table ends at the end of input
    if (inTable && currentTable.length > 0) {
      tableMatches.push(currentTable.join('\n'));
    }

    if (tableMatches.length > 0) {
      response.tables = tableMatches
        .map((tableText, index) => {
          const lines = tableText
            .trim()
            .split('\n')
            .filter((line) => line.includes('|'));

          if (lines.length < 2) return null;

          // Extract headers
          const headers = lines[0]
            .split('|')
            .map((cell) => cell.trim())
            .filter((cell) => cell !== '');

          // Skip separator line and extract rows
          const rows = lines.slice(2).map((line) =>
            line
              .split('|')
              .map((cell) => cell.trim())
              .filter((cell) => cell !== ''),
          );

          return {
            id: `table_${index + 1}`,
            headers,
            rows,
            title: `Table ${index + 1}`,
          };
        })
        .filter((table) => table !== null);

      if (response.tables.length > 0) {
        response.metadata.hasStructuredContent = true;
      }
    }

    // If no structured content found, put everything in shortAnswer
    if (!response.metadata.hasStructuredContent) {
      // Return the full response as shortAnswer instead of truncating
      response.shortAnswer = cleanResponse;
    } else {
      // Extract remaining content as reasoning
      let remainingContent = cleanResponse;

      // Remove short answer section
      if (shortAnswerMatch) {
        remainingContent = remainingContent
          .replace(shortAnswerMatch[0], '')
          .trim();
      }

      // Remove sections
      if (sectionMatches) {
        sectionMatches.forEach((section) => {
          remainingContent = remainingContent.replace(section, '').trim();
        });
      }

      // Remove tables
      if (tableMatches) {
        tableMatches.forEach((table) => {
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
      shortAnswer:
        rawResponse.length > 200
          ? `${rawResponse.substring(0, 200)}...`
          : rawResponse,
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
