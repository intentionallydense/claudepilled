# Apple Watch Voice Chat Shortcut

Voice-based interaction with claude-wrapper from Apple Watch via Shortcuts app.
The watch uses built-in speech-to-text, sends transcribed text to the server
over Tailscale, and displays the response as text on the watch screen.

## Prerequisites

- claude-wrapper running on a machine reachable via Tailscale
- Server URL: `http://100.103.65.102:8000` (adjust to your Tailscale IP)

## API Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `POST /api/chat/{id}/message` | Send message, get full response (sync) |
| `POST /api/conversations` | Create new conversation |
| `GET /api/conversations?limit=10` | List recent conversations |
| `POST /api/pins` | Create a pin |

## Shortcut Setup

Create a single shortcut with a **Menu** at the top offering four options:

### Menu Option 1: New Chat

1. **Dictate Text** — speech-to-text input
2. **Get Contents of URL**
   - URL: `http://100.103.65.102:8000/api/conversations`
   - Method: POST
   - Headers: `Content-Type: application/json`
   - Body (JSON):
     ```json
     {"title": "Watch chat"}
     ```
3. **Get Dictionary Value** — key: `id` (from step 2 result)
4. **Get Contents of URL**
   - URL: `http://100.103.65.102:8000/api/chat/{id}/message` (use variable from step 3)
   - Method: POST
   - Headers: `Content-Type: application/json`
   - Body (JSON):
     ```json
     {"message": "{Dictated Text}"}
     ```
5. **Get Dictionary Value** — key: `text` (from step 4 result)
6. **Show Result** — display the text

### Menu Option 2: Continue Chat

1. **Get Contents of URL**
   - URL: `http://100.103.65.102:8000/api/conversations?limit=10`
   - Method: GET
2. **Repeat with Each** item in result
   - **Get Dictionary Value** — key: `title`
   - **End Repeat**
3. **Choose from List** — shows conversation titles
4. **Get Dictionary Value** — key: `id` (from the chosen item in the original list)
5. **Dictate Text** — speech-to-text input
6. **Get Contents of URL**
   - URL: `http://100.103.65.102:8000/api/chat/{id}/message`
   - Method: POST
   - Headers: `Content-Type: application/json`
   - Body (JSON):
     ```json
     {"message": "{Dictated Text}"}
     ```
7. **Get Dictionary Value** — key: `text`
8. **Show Result**

### Menu Option 3: Pin

1. **Dictate Text**
2. **Get Contents of URL**
   - URL: `http://100.103.65.102:8000/api/pins`
   - Method: POST
   - Headers: `Content-Type: application/json`
   - Body (JSON):
     ```json
     {"type": "text", "content": "{Dictated Text}", "tags": ["watch"], "source": "watch"}
     ```
3. **Show Alert** — "Pinned!"

### Menu Option 4: Brain Dump

1. **Dictate Text**
2. **Get Contents of URL**
   - URL: `http://100.103.65.102:8000/api/conversations`
   - Method: POST
   - Headers: `Content-Type: application/json`
   - Body (JSON):
     ```json
     {"title": "Brain dump", "prompt_id": "brain_dump"}
     ```
3. **Get Dictionary Value** — key: `id`
4. **Get Contents of URL**
   - URL: `http://100.103.65.102:8000/api/chat/{id}/message`
   - Method: POST
   - Headers: `Content-Type: application/json`
   - Body (JSON):
     ```json
     {"message": "{Dictated Text}"}
     ```
5. **Get Dictionary Value** — key: `text`
6. **Show Result**

## Notes

- The sync chat endpoint has no timeout limit — long responses (tool use loops,
  thinking) will block until complete. Apple Shortcuts has a 60-second HTTP
  timeout by default, which should be sufficient for most responses.
- Brain dump uses the seeded "Brain dump" prompt which triggers task extraction.
- The `?limit=10` param on conversations keeps the list manageable on the watch.
