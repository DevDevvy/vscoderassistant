const vscode = require('vscode');
const fs = require('fs');
const OpenAI = require('openai');
const path = require('path');
const xml2js = require('xml2js');
const crypto = require('crypto');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
function getProjectIdentifier() {
	if (!vscode.workspace.workspaceFolders) {
		return 'default-session';  // Fallback for no workspace scenario
	}
	const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
	return crypto.createHash('md5').update(rootPath).digest('hex');
}
async function checkIfThreadExists(threadId) {
	try {
		// Attempt to retrieve the thread or perform a benign operation
		// Assuming OpenAI has a way to retrieve thread metadata (this is hypothetical)
		const response = await openai.beta.threads.retrieve(threadId);
		return true;  // If no error, the thread exists
	} catch (error) {
		if (error.response && error.response.status === 404) {
			return false;  // Thread does not exist
		}
		throw error;  // Re-throw the error if it's not a simple "not found" error
	}
}

async function createThreadWithRetry(maxRetries = 3) {
	let retries = 0;
	while (retries < maxRetries) {
		try {
			const initialMessages = [{
				role: "user",
				content: "You are a highly skilled assistant specialized in software development. Your responses should be formatted using specific XML tags to structure actions such as creating folders, files, and editing content. Each response should adhere to the best practices in coding, focusing on security, scalability, and performance. Please use the following XML tags in your responses: <response>, <action>, <fileName>, <edit>. Each <action> should specify the type—either createFolder, createFile, or editFile—and relevant details. Your expertise should reflect modern coding standards, best practices, security and file structure."
			}];

			const response = await openai.beta.threads.create({
				messages: initialMessages
			});
			console.log('Thread created with initial system message:', response);
			return response.id;
		} catch (error) {
			console.error(`Attempt ${retries + 1}: Failed to create thread`, error.response || error.message);
			retries++;
			if (retries === maxRetries) {
				throw new Error(`Failed to create thread after ${maxRetries} attempts`);
			}
		}
	}
}

async function getOrCreateThread(context) {
	const projectId = getProjectIdentifier();
	let threadId = context.globalState.get(projectId);

	// Function to create a new thread and save its ID
	async function createAndSaveNewThread() {
		try {
			threadId = await createThreadWithRetry();
			await context.globalState.update(projectId, threadId);
			console.log(`New thread created and stored for project ${projectId}: ${threadId}`);
		} catch (error) {
			vscode.window.showErrorMessage('Failed to initialize a new conversation thread.');
			console.error('Error creating thread:', error);
			return null;  // Return null to indicate failure to create a thread
		}
		return threadId;
	}

	if (!threadId) {
		// No thread ID is currently stored, so create a new thread
		return await createAndSaveNewThread();
	} else {
		// Verify if the existing threadId is still valid by making a test API call or similar
		try {
			// This is a hypothetical function to check if the thread exists; you may need to implement this based on OpenAI's API capabilities
			const isValid = await checkIfThreadExists(threadId);
			if (!isValid) {
				console.log(`Stored thread ID is no longer valid, creating a new thread for project ${projectId}`);
				return await createAndSaveNewThread();
			}
			console.log(`Using existing thread ID for project ${projectId}: ${threadId}`);
		} catch (error) {
			console.error(`Error validating thread ID ${threadId}:`, error);
			return await createAndSaveNewThread();
		}
	}

	return threadId;
}




function generateResponse(promptText, threadId, context) {
	return new Promise(async (resolve, reject) => {
		if (!threadId) {
			console.log("No valid thread ID available, creating a new thread.");
			try {
				threadId = await getOrCreateThread(context);
				if (!threadId) {
					return reject(new Error("Failed to create a new thread."));
				}
			} catch (error) {
				return reject(new Error("Failed to initialize a new thread: " + error.message));
			}
		}


		openai.beta.threads.messages.create(threadId, { role: "user", content: promptText }).then(response => {
			const fullResponse = response.content[0].text.value;
			resolve(handleResponse(fullResponse));
		}).catch(err => {
			vscode.window.showErrorMessage('Failed to generate response: ' + err.message);
			reject(err);
		});
	});
}


function handleResponse(fullResponse) {
	console.log("Received response to parse as XML:", fullResponse);
	xml2js.parseString(fullResponse, (err, result) => {
		if (err) {
			vscode.window.showErrorMessage('Failed to parse XML: ' + err.message);
			return;
		}

		const actions = result.response.action || [];
		actions.forEach(action => {
			const type = action.$.type;
			switch (type) {
				case "createFolder":
					createFolder(action.$.folderName);
					break;
				case "createFile":
					createFile(action.$.fileName, action._);
					break;
				case "editFile":
					editFile(action.$.fileName, action._);
					break;
			}
		});
	});

	return "Actions completed.";
}

function createFolder(folderName) {
	const folderPath = path.join(vscode.workspace.rootPath, folderName);
	if (!fs.existsSync(folderPath)) {
		fs.mkdirSync(folderPath, { recursive: true });
		vscode.window.showInformationMessage('Folder created: ' + folderName);
	}
}

function createFile(fileName, content) {
	const filePath = path.join(vscode.workspace.rootPath, fileName);
	fs.writeFile(filePath, content, { flag: 'w' }, err => {
		if (err) {
			vscode.window.showErrorMessage('Failed to create file: ' + err.message);
		} else {
			vscode.window.showInformationMessage('File created successfully: ' + fileName);
		}
	});
}

function editFile(fileName, content) {
	const filePath = path.join(vscode.workspace.rootPath, fileName);
	fs.appendFile(filePath, content, err => {
		if (err) {
			vscode.window.showErrorMessage('Failed to edit file: ' + err.message);
		} else {
			vscode.window.showInformationMessage('File edited successfully: ' + fileName);
		}
	});
}

const activate = (context) => {
	let disposable = vscode.commands.registerCommand('extension.openChat', async function () {
		const panel = vscode.window.createWebviewPanel(
			'chat',
			'Chat with Code Collaborator',
			vscode.ViewColumn.One,
			{ enableScripts: true }
		);

		const fileData = getWorkspaceFiles();
		const fileDataJSON = JSON.stringify(fileData);
		panel.webview.html = getWebviewContent(fileDataJSON);

		let threadId = await getOrCreateThread(context);
		panel.webview.onDidReceiveMessage(
			async message => {
				console.log('Received message:', message);
				const promptWithFileContext = `File: ${message.filePath}\nPrompt: ${message.promptText}`;
				generateResponse(promptWithFileContext, threadId, context).then(response => {
					console.log('Generated response:', response);
					panel.webview.postMessage({ type: 'response', content: response });
				}).catch(error => {
					panel.webview.postMessage({ type: 'error', content: 'Error: ' + error.toString() });
				});
			},
			undefined,
			context.subscriptions
		);
	});

	context.subscriptions.push(disposable);
}



function getWebviewContent(fileDataJSON) {
	return `<!DOCTYPE html>
<html lang="en">
<head>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            padding: 10px;
        }
        select, textarea, button {
            width: 100%;
            margin-bottom: 10px;
            padding: 8px;
        }
		textarea {
			focus: true;
		}
        button {
            background-color: #007ACC;
            color: white;
            border: none;
            cursor: pointer;
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
    <textarea id="chatInput" placeholder="Type your query here..."></textarea>
    <button onclick="sendMessage()">Send Prompt</button>
    <div id="responseContainer"></div>
    <script>
        const vscode = acquireVsCodeApi();
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'response':
                    const responseContainer = document.createElement('p');
                    responseContainer.textContent = 'Response: ' + message.content;
                    document.body.appendChild(responseContainer);
                    break;
                case 'error':
                    const errorContainer = document.createElement('p');
                    errorContainer.textContent = 'Error: ' + message.content;
                    document.body.appendChild(errorContainer);
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



function getWorkspaceFiles() {
	let workspaceFiles = [];
	if (vscode.workspace.workspaceFolders) {
		vscode.workspace.workspaceFolders.forEach(folder => {
			let workspaceRoot = folder.uri.fsPath;
			let files = getAllFiles(workspaceRoot);
			workspaceFiles.push(...files);
		});
	}
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