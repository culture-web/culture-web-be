-- Set up cascading delete for messages table
-- When a message is deleted, automatically delete any messages that reference it in response_for

-- First, check if the foreign key constraint already exists and drop it if needed
ALTER TABLE messages DROP CONSTRAINT IF EXISTS fk_messages_response_for;

-- Add foreign key constraint with CASCADE DELETE
ALTER TABLE messages 
ADD CONSTRAINT fk_messages_response_for 
FOREIGN KEY (response_for) 
REFERENCES messages(id) 
ON DELETE CASCADE;

-- Optional: Add index on response_for for better performance
CREATE INDEX IF NOT EXISTS idx_messages_response_for ON messages(response_for);