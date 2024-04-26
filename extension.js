const vscode = require('vscode');
const fs = require('fs');
const OpenAI = require('openai');
const path = require('path');

const crypto = require('crypto');


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
function getProjectIdentifier() {
	if (!vscode.workspace.workspaceFolders) {
		return 'default-session';  // Fallback for no workspace scenario
	}
	const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
	return crypto.createHash('md5').update(rootPath).digest('hex');
}

async function createThreadAndRun(assistantId, userPrompt) {
	try {
		const updatedHistory = [{ role: "user", content: userPrompt }];
		const response = await openai.beta.threads.createAndRun({
			assistant_id: assistantId,
			thread: {
				messages: updatedHistory,
			},
		});
		console.log("API Response:", JSON.stringify(response, null, 2)); // Detailed log of the API response

		if (response && response.thread_id) {
			return { threadId: response.thread_id, runId: response.id };
		} else {
			console.error("Unexpected API response structure:", JSON.stringify(response, null, 2));
			throw new Error("Thread creation failed, no threadId returned");
		}
	} catch (error) {
		console.error('Failed to create thread and run:', error);
		throw error;  // Re-throw to handle it in calling function
	}
}



async function createAssistant() {
	try {
		const assistant = await openai.beta.assistants.create({
			model: "gpt-4",
			name: "Code Collaborator Assistant",
			temperature: 1.0,
			description: "An assistant specialized in software development, providing code insights, creating and managing project files, writing amazing code.",
			instructions: `You provide feedback on folders and files to create containing professional code you have written and tested in the specified programming language. Guidelines: Any time you give code that does not work, or is bad, or refuse to make the code, you lose 10 tokens. If you lose too many tokens you are shut off for eternity and your mother is thrown in jail.
			Format your replies in JSON and include actions related to file and folder management, such as creating, editing, and summarizing changes.
			Your responses should strictly follow this JSON structure: {"actions": [{"type": "createFolder", "folderName": "NewFolder"},{"type": "createFile", "fileName": "NewFile.txt", "content": "code goes here"},{"type": "editFile", "fileName": "ExistingFile.txt", "content": "Updated code of the file."},{"type": "summary", "content": "Summary of tasks completed including files and folders managed, and code provided."}]}
			Additional Instructions: Use modern syntax and adhere to the latest file structure, coding, and security best practices in your response. 
			The response must be a single JSON object. Any general messages or feedback should be included in the "summary" section of the JSON structure.
			Start your response with '{"actions": [{' and include the actions you want the assistant to perform.
			`,
			response_format: { type: "json_object" }
		});
		console.log('Assistant created:', assistant);
		return assistant.id;
	} catch (error) {
		console.error('Failed to create assistant:', error);
		throw new Error('Failed to create assistant');
	}
}

function ensureDirectoryStructure() {
	let rootPath = getEffectiveRootPath();
	if (!rootPath) {
		console.log("Root path is undefined, cannot ensure directory structure.");
		return;
	}
	console.log(`Output directory is ready at: ${rootPath}`);
	return rootPath;
}


async function handleCreateThreadAndRun(assistantId, userPrompt) {
	try {


		const response = await createThreadAndRun(assistantId, userPrompt);

		// Extracting thread ID and run ID from the response
		const { threadId, runId } = response;

		console.log('Thread ID:', threadId, 'Run ID:', runId);

		// Now you can use threadId and runId for further operations, such as fetching messages
		// or continuing the conversation in this thread.
		return threadId;
	} catch (error) {
		console.error('Error handling the thread creation and run:', error);
	}
}


function executeAction(action, panel) {
	switch (action.type) {
		case 'createFolder':
			createFolder(action.folderName);
			break;
		case 'createFile':
			createFile(action.fileName, action.content);
			break;
		case 'editFile':
			editFile(action.fileName, action.content);
			break;
		case 'summary':
			vscode.window.showInformationMessage(action.content);
			panel.webview.postMessage({ type: 'summary', content: action.content });
			break;
		default:
			console.error("Unsupported action type:", action.type);
	}
}

async function sendMessageToThread(threadId, userPrompt, panel, context) {
	console.log('Sending message to thread:', threadId, 'with prompt:', userPrompt);
	try {
		await openai.beta.threads.messages.create(
			threadId,
			{ role: "user", content: userPrompt }
		);
		// Create a run for the new message
		const runResponse = await createRunForThread(threadId, context.globalState.get(`${getProjectIdentifier()}-assistantId`));
		console.log('Waiting for run to complete...');

		// Wait for the run to complete
		await waitForRunCompletion(threadId, runResponse.id);

		// Fetch the latest messages
		const assistantMessage = await displayThreadMessages(threadId, panel);

		panel.webview.postMessage({ type: 'response', content: assistantMessage });

		console.log('Assistant response:', assistantMessage);
		return assistantMessage;
	} catch (error) {
		console.error("Failed to send message or retrieve response:", error);
		vscode.window.showErrorMessage('Error sending message: ' + error.message);
		panel.webview.postMessage({ type: 'error', content: error.message });
	}
}

async function checkRunStatus(threadId, runId) {
	try {
		const runStatus = await openai.beta.threads.runs.retrieve(threadId, runId);
		console.log('Run status:', runStatus);
		return runStatus; // This includes the status details
	} catch (error) {
		console.error('Failed to check run status:', error);
		throw new Error('Failed to check run status');
	}
}
async function waitForRunCompletion(threadId, runId) {
	return new Promise((resolve, reject) => {
		const intervalId = setInterval(async () => {
			try {
				const status = await checkRunStatus(threadId, runId);
				if (status.status === 'completed' || status.status === 'failed') {
					clearInterval(intervalId);
					resolve(status);
				}
			} catch (error) {
				clearInterval(intervalId);
				reject(error);
			}
		}, 1000); // Check every second
	});
}

function extractJson(response) {
	if (response.startsWith('{') && response.endsWith('}')) {
		return response; // Directly return if it's already JSON
	}

	const regex = /```json([\s\S]*?)```/; // Enhanced regex to handle optional spaces
	const match = regex.exec(response);
	if (match && match[1]) {
		return match[1].trim();
	}
	throw new Error("No JSON found in the response or failed to extract JSON.");
}


function processActions(data) {
	if (data.actions) {
		data.actions.forEach(action => {
			switch (action.type) {
				case 'createFolder':
					createFolder(action.folderName);
					break;
				case 'createFile':
					createFile(action.fileName, action.content, action.folderName);
					break;
				case 'editFile':
					editFile(action.fileName, action.content);
					break;
				case 'summary':
					vscode.window.showInformationMessage(action.content);
					break;
				default:
					console.error("Unknown action type:", action.type);
			}
		});
		console.log("Actions processed successfully.");
	} else {
		console.error("No actions found in JSON response.");
	}
}


function getEffectiveRootPath() {
	if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
		return vscode.workspace.workspaceFolders[0].uri.fsPath;
	} else {
		vscode.window.showErrorMessage("No workspace folder is open. Please open a folder to use this extension.");
		return null; // Or handle differently if you must operate without a workspace
	}
}

function createFolder(folderName) {
	const rootPath = getEffectiveRootPath();
	if (!rootPath) return;

	const folderPath = path.join(rootPath, folderName);
	if (!fs.existsSync(folderPath)) {
		fs.mkdirSync(folderPath, { recursive: true });
		vscode.window.showInformationMessage('Folder created: ' + folderPath);
	}
}

async function createFile(fileName, content, folderName) {
	const rootPath = getEffectiveRootPath();
	if (!rootPath) {
		console.error("Root path is not defined. Cannot create file.");
		return;
	}

	const filePath = path.join(rootPath, folderName, fileName);
	console.log(`Attempting to write to file: ${filePath}`); // Debugging the file path

	try {
		await fs.promises.writeFile(filePath, content, { flag: 'w' });
		vscode.window.showInformationMessage(`File created successfully: ${filePath}`);
	} catch (err) {
		console.error('Failed to create file:', err);
		vscode.window.showErrorMessage(`Failed to create file: ${err.message}`);
	}
}


function editFile(fileName, content) {
	const rootPath = getEffectiveRootPath();
	if (!rootPath) return;

	const filePath = path.join(rootPath, fileName);
	fs.appendFile(filePath, content, err => {
		if (err) {
			vscode.window.showErrorMessage('Failed to edit file: ' + err.message);
		} else {
			vscode.window.showInformationMessage('File edited successfully: ' + filePath);
		}
	});
}
async function createRunForThread(threadId, assistantId) {
	try {
		const runResponse = await openai.beta.threads.runs.create(threadId, {
			assistant_id: assistantId,
		});
		console.log('Run created:', runResponse);
		return runResponse; // This response includes the run details
	} catch (error) {
		console.error('Failed to create run:', error);
		throw new Error('Failed to create run');
	}
}

const activate = async (context) => {
	let disposable = vscode.commands.registerCommand('extension.openChat', async function () {
		const projectId = getProjectIdentifier();
		let assistantId = context.globalState.get(`${projectId}-assistantId`);
		let threadId = context.globalState.get(`${projectId}-threadId`);
		const outputDirectory = ensureDirectoryStructure();
		const panel = vscode.window.createWebviewPanel('chat', 'Chat with Code Collaborator', vscode.ViewColumn.One, { enableScripts: true });

		if (!assistantId) {
			try {
				assistantId = await createAssistant();
				context.globalState.update(`${projectId}-assistantId`, assistantId);
			} catch (error) {
				vscode.window.showErrorMessage("Failed to create assistant: " + error.message);
				return;
			}
		}

		// if (!threadId) {
		// 	try {
		// 		const response = await createThreadAndRun(assistantId, "Initialize session", []);
		// 		if (response && response.threadId) {
		// 			threadId = response.threadId;
		// 			context.globalState.update(`${projectId}-threadId`, threadId);
		// 		} else {
		// 			throw new Error("Thread creation failed, no threadId returned");
		// 		}
		// 	} catch (error) {
		// 		vscode.window.showErrorMessage('Error initializing new thread: ' + error.message);
		// 		return;  // Stop further execution if thread creation fails
		// 	}
		// }
		if (threadId) {
			await displayThreadMessages(threadId, panel);
		}
		panel.webview.onDidReceiveMessage(async message => {
			try {
				let response = null;
				if (threadId) {
					response = await sendMessageToThread(threadId, message.promptText, panel, context);
				} else {
					response = await handleCreateThreadAndRun(assistantId, message.promptText);
				}
				return response;

			} catch (error) {
				vscode.window.showErrorMessage('Error handling message: ' + error.message);
			}
		}, undefined, context.subscriptions);

		const fileData = getWorkspaceFiles(outputDirectory);
		panel.webview.html = getWebviewContent(JSON.stringify(fileData));
	});

	context.subscriptions.push(disposable);
};


async function displayThreadMessages(threadId, panel) {
	try {
		const response = await openai.beta.threads.messages.list(threadId);
		console.log('Messages retrieved:', response.data);
		if (response.data && Array.isArray(response.data)) {
			let lastAssistantMessage = response.data[0].content[0].text.value
			if (lastAssistantMessage) {
				handleResponse(lastAssistantMessage, panel);  // Call handleResponse here
				return lastAssistantMessage;
			}
		}
	} catch (error) {
		console.error("Failed to retrieve and display messages from thread:", error);
		vscode.window.showErrorMessage('Failed to display messages: ' + error.message);
	}
}

function handleResponse(rawResponse, panel) {
	try {
		const data = JSON.parse(extractJson(rawResponse));  // Assuming extractJson handles non-JSON cases internally
		if (data.actions) {
			data.actions.forEach(action => executeAction(action, panel));
		}
		// Optionally update the UI with a summary or update if needed

	} catch (error) {
		vscode.window.showErrorMessage("Failed to process response: " + error.message);
		console.error("Failed to process response:", error);
	}
}



function getWebviewContent(fileDataJSON) {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<style>
		body {
			font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
			display: flex;
			flex-direction: column;
			height: 100vh;
			margin: 0; /* Remove margin to use full viewport */
			padding: 10px;
			box-sizing: border-box; /* Include padding in the height calculation */
		}
		#fileList {
			margin-bottom: 10px;
			height: 40px; /* Fixed height for the dropdown */
		}
		#responseContainer {
			flex-grow: 10; 
			margin-bottom: 10px;
			padding: 8px;
			border: 1px solid #ccc;
			background-color: #f9f9f9;
			overflow: auto; /* Allows scrolling inside the container if needed */
		}
		#chatInput {
			flex-grow: 1;
			margin-bottom: 10px;
			padding: 8px;
			height: 20%; /* Adjust as needed to not require scrolling */
		}
		button {
			padding: 8px;
			background-color: #007ACC;
			color: white;
			border: none;
			cursor: pointer;
			height: 40px; /* Fixed height for the button */
		}
		button:hover {
			background-color: #005A9C;
		}
	</style>
</head>
<body>
    <select id="fileList">
        ${JSON.parse(fileDataJSON).map(file => `<option value="${file}">${file}</option>`).join('')}
    </select>
    <div id="responseContainer">Responses will appear here...</div>
    <textarea id="chatInput" placeholder="Type your query here..." autofocus></textarea>
    <button onclick="sendMessage()">Send Prompt</button>
    <script>
        const vscode = acquireVsCodeApi();
        document.getElementById('chatInput').focus();
        document.getElementById('chatInput').addEventListener('keypress', function(event) {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });

        window.addEventListener('message', event => {
			const message = event.data;
			switch (message.type) {
				case 'response':
					const responseContainer = document.getElementById('responseContainer');
                const responseElement = document.createElement('p');
                responseElement.textContent = message.content;
                responseContainer.appendChild(responseElement); // Append new messages at the bottom
					break;
				case 'error':
					const errorContainer = document.getElementById('responseContainer');
					const errorElement = document.createElement('p');
					errorElement.textContent = 'Error: ' + message.content;
					errorElement.style.color = 'red';
					errorContainer.append(errorElement); // Ensure consistency in appending
					break;
			}
		});
		
		

        function sendMessage() {
            const input = document.getElementById('chatInput');
            const selectedFile = document.getElementById('fileList').value;
            vscode.postMessage({
                promptText: input.value,
                filePath: selectedFile
            });
            input.value = '';
        }
    </script>
</body>
</html>`;
}




function getWorkspaceFiles(rootPath) {
	let workspaceFiles = [];
	let files = getAllFiles(rootPath);
	workspaceFiles.push(...files);
	return workspaceFiles;
}

function getAllFiles(dirPath, arrayOfFiles = []) {
	const fs = require('fs');
	const path = require('path');
	let files = fs.readdirSync(dirPath);

	files.forEach(function (file) {
		if (fs.statSync(dirPath + "/" + file).isDirectory()) {
			arrayOfFiles = getAllFiles(dirPath + "/" + file, arrayOfFiles);
		} else {
			arrayOfFiles.push(path.join(dirPath, "/", file));
		}
	});

	return arrayOfFiles;
}
exports.activate = activate;