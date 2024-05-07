# coderassistant README

To run in test:

## 1. Open the test window:

- Download the code and open it in VSCode
- On left column press the play/debug button
- At the top make sure "Run Extension" is chosen
- Press the green play button

## 2. Run a test

- In new test window choose file to work on
- Press "cmd + shift + p" to open the command pallet
- search "Open Chat" and click on it

This Visual Studio Code (VS Code) extension integrates OpenAI's API to enhance a development environment by providing AI-powered code assistance directly within VS Code. Here's a breakdown of how it works and what each part of the code does:

### Overview of the Extension

1.  **Initialization and Dependencies**: The extension requires several Node.js modules like `vscode`, `fs` (file system), `crypto` for hashing, and `openai` for interacting with OpenAI’s API.
2.  **API Key and OpenAI Client**: It initializes an OpenAI client using an API key stored in environment variables, ensuring secure authentication when making API calls.
3.  **Project Identifier**: A unique identifier for each VS Code workspace is generated using MD5 hashing of the workspace’s root path. This helps in managing session-specific data effectively.

### Core Functions

1.  **Creating Assistants and Threads**:

    - `createAssistant`: Sets up an AI assistant with specific characteristics tailored for software development, such as generating and managing code.
    - `createThread` and `createThreadAndRun`: These functions initiate a conversation (thread) with the assistant. `createThreadAndRun` also sends an initial prompt along with the project file structure.

2.  **Messaging and Communication**:

    - `sendMessageToThread`: Sends user inputs to the ongoing thread and handles AI responses. It updates the user interface based on the AI's suggestions or error messages.
    - The responses and interaction are managed asynchronously, allowing real-time updates and continuous interaction within the development workspace.

3.  **File and Folder Management**:

    - `executeAction`: Executes actions like creating or editing files and folders based on the AI's recommendations.
    - These actions are parsed from JSON structured responses from the AI, demonstrating the extension's ability to automate parts of the coding process based on AI insights.

4.  **Utility Functions**:

    - `buildFileStructureTree` and `getWorkspaceFiles`: These functions handle the reading and structuring of the project’s directory tree, providing the AI with the context needed to understand the current state of the project.
    - `waitForRunCompletion`: Monitors the status of a running AI process, ensuring that responses are handled once the process completes.

### Webview Panel

## The extension uses a webview panel to create a custom UI within VS Code. This UI includes:

- An input area for user commands.
- A display area for AI responses.
- Integration with the VS Code message passing interface to handle interactions dynamically.

### Event Handling

The extension listens to specific events like button clicks or message receipts to interact with the AI, update the UI, and handle user inputs efficiently.
