// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const simpleGit = require('simple-git');

// Update the git initialization
function getGit() {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		throw new Error('No workspace folder open');
	}
	
	// Use the first workspace folder as the git repository path
	const gitPath = workspaceFolders[0].uri.fsPath;
	return simpleGit(gitPath);
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	// Register analyze history command
	let analyzeHistory = vscode.commands.registerCommand('studygit.analyzeHistory', async () => {
		try {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			console.log('Workspace folders:', workspaceFolders);
			
			const git = getGit();
			console.log('Git path:', git.cwd());  // This will show the current working directory
			
			const commits = await git.log();
			// Create and show commit history webview
			const panel = vscode.window.createWebviewPanel(
				'studyGitHistory',
				'StudyGit History',
				vscode.ViewColumn.One,
				{
					enableScripts: true
				}
			);
			
			// Generate HTML content for the webview
			panel.webview.html = generateHistoryView(commits);
		} catch (error) {
			console.error('Full error:', error);
			vscode.window.showErrorMessage('Failed to analyze git history: ' + error.message);
		}
	});

	// Register playback command
	let startPlayback = vscode.commands.registerCommand('studygit.startPlayback', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('No active editor');
			return;
		}

		const speed = vscode.workspace.getConfiguration('studygit').get('playbackSpeed');
		await playbackCode(editor, speed);
	});

	context.subscriptions.push(analyzeHistory, startPlayback);
}

async function playbackCode(editor, speed) {
	const document = editor.document;
	const text = document.getText();
	let lines = text.split('\n');
	
	// Create virtual document for playback
	const virtualDoc = await vscode.workspace.openTextDocument({
		content: '',
		language: document.languageId
	});
	const virtualEditor = await vscode.window.showTextDocument(virtualDoc, {
		preview: false,
		viewColumn: vscode.ViewColumn.Beside
	});

	let isPaused = false;
	let currentLine = 0;
	let currentChar = 0;
	let isPlaybackActive = true;
	
	// Add playback controls
	const playbackControls = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	playbackControls.text = "$(debug-pause) Pause | $(chevron-left) Back | $(chevron-right) Forward";
	playbackControls.command = 'studygit.togglePlayback';
	playbackControls.show();

	// Register control commands
	let togglePause = vscode.commands.registerCommand('studygit.togglePlayback', () => {
		isPaused = !isPaused;
		playbackControls.text = isPaused ? 
			"$(debug-start) Play | $(chevron-left) Back | $(chevron-right) Forward" :
			"$(debug-pause) Pause | $(chevron-left) Back | $(chevron-right) Forward";
	});

	let goBack = vscode.commands.registerCommand('studygit.stepBack', async () => {
		if (currentChar > 0) {
			currentChar--;
		} else if (currentLine > 0) {
			currentLine--;
			currentChar = lines[currentLine].length;
		}
		await updateVirtualDoc();
	});

	let goForward = vscode.commands.registerCommand('studygit.stepForward', async () => {
		if (currentLine < lines.length && currentChar < lines[currentLine].length) {
			currentChar++;
		} else if (currentLine < lines.length - 1) {
			currentLine++;
			currentChar = 0;
		}
		await updateVirtualDoc();
	});

	async function updateVirtualDoc() {
		let content = '';
		for (let i = 0; i <= currentLine && i < lines.length; i++) {
			if (i === currentLine) {
				content += lines[i].substring(0, Math.min(currentChar, lines[i].length));
			} else {
				content += lines[i] + '\n';
			}
		}
		await virtualEditor.edit(editBuilder => {
			const lastLine = virtualDoc.lineCount - 1;
			const lastChar = virtualDoc.lineAt(lastLine).text.length;
			editBuilder.delete(new vscode.Range(0, 0, lastLine, lastChar));
			editBuilder.insert(new vscode.Position(0, 0), content);
		});
	}

	// Listen for tab close event
	const disposable = vscode.window.onDidChangeActiveTextEditor((e) => {
		if (e && e.document !== virtualDoc) {
			isPlaybackActive = false;
			cleanup();
		}
	});

	// Main playback loop
	while (currentLine < lines.length && isPlaybackActive) {
		if (!isPaused) {
			await new Promise(resolve => setTimeout(resolve, speed));
			
			if (currentLine < lines.length && currentChar < lines[currentLine].length) {
				currentChar++;
			} else if (currentLine < lines.length - 1) {
				currentLine++;
				currentChar = 0;
			} else {
				break; // End of document reached
			}
			
			await updateVirtualDoc();
		} else {
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}

	// Cleanup function
	function cleanup() {
		playbackControls.dispose();
		togglePause.dispose();
		goBack.dispose();
		goForward.dispose();
		disposable.dispose();
		if (!virtualEditor.document.isClosed) {
			virtualEditor.hide();
		}
	}

	// If playback completed naturally, call cleanup
	if (isPlaybackActive) {
		cleanup();
	}
}

function generateHistoryView(commits) {
	return `
		<!DOCTYPE html>
		<html>
		<head>
			<style>
				body { font-family: Arial, sans-serif; background-color: #1e1e1e; color: #d4d4d4; }
				.commit { padding: 15px; margin: 10px 0; border: 1px solid #3c3c3c; border-radius: 5px; background-color: #252526; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
				.commit-short { display: none; }
				.commit-full { display: block; }
				.toggle-btn { cursor: pointer; color: #569cd6; text-decoration: none; font-weight: bold; }
				.toggle-btn:hover { text-decoration: underline; }
				.sort-options, .search-options { margin-bottom: 20px; background-color: #252526; padding: 15px; border-radius: 5px; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
				.sort-btn, .search-btn {
					padding: 8px 15px;
					margin: 0 5px;
					background-color: #0e639c;
					color: #ffffff;
					border: none;
					border-radius: 4px;
					cursor: pointer;
					transition: background-color 0.3s;
				}
				.sort-btn:hover, .search-btn:hover {
					background-color: #1177bb;
				}
				#searchInput, #searchType {
					padding: 8px;
					margin-right: 10px;
					border: 1px solid #3c3c3c;
					border-radius: 4px;
					background-color: #3c3c3c;
					color: #d4d4d4;
				}
				#searchInput { width: 250px; }
				h1 { color: #d4d4d4; text-align: center; }
				h3 { color: #569cd6; }
			</style>
			<script>
				function toggleCommit(hash) {
					const shortEl = document.getElementById('short-' + hash);
					const fullEl = document.getElementById('full-' + hash);
					if (shortEl.style.display === 'none') {
						shortEl.style.display = 'block';
						fullEl.style.display = 'none';
					} else {
						shortEl.style.display = 'none';
						fullEl.style.display = 'block';
					}
				}

				function sortCommits(criteria, reverse = false) {
					const commitsContainer = document.getElementById('commits');
					const commits = Array.from(commitsContainer.children);
					
					commits.sort((a, b) => {
						let aValue, bValue;
						switch(criteria) {
							case 'time':
								aValue = new Date(a.dataset.date);
								bValue = new Date(b.dataset.date);
								break;
							case 'author':
								aValue = a.dataset.author;
								bValue = b.dataset.author;
								break;
							default:
								return 0;
						}
						return reverse ? (aValue < bValue ? 1 : -1) : (aValue > bValue ? 1 : -1);
					});

					commits.forEach(commit => commitsContainer.appendChild(commit));
				}

				function searchCommits() {
					const searchTerm = document.getElementById('searchInput').value.toLowerCase();
					const searchType = document.getElementById('searchType').value;
					const commits = document.getElementsByClassName('commit');

					Array.from(commits).forEach(commit => {
						let shouldShow = false;
						const fullCommit = commit.querySelector('.commit-full');
						switch(searchType) {
							case 'message':
								shouldShow = fullCommit.querySelector('h3').textContent.toLowerCase().includes(searchTerm);
								break;
							case 'author':
								shouldShow = commit.dataset.author.toLowerCase().includes(searchTerm);
								break;
							case 'hash':
								shouldShow = fullCommit.querySelector('p:last-of-type').textContent.toLowerCase().includes(searchTerm);
								break;
							case 'all':
								shouldShow = fullCommit.textContent.toLowerCase().includes(searchTerm);
								break;
						}
						commit.style.display = shouldShow ? 'block' : 'none';
					});
				}
			</script>
		</head>
		<body>
			<h1>Git History Analysis</h1>
			<div class="sort-options">
				<h2>Sort Commits</h2>
				<button class="sort-btn" onclick="sortCommits('time')">Time ↑</button>
				<button class="sort-btn" onclick="sortCommits('time', true)">Time ↓</button>
				<button class="sort-btn" onclick="sortCommits('author')">Author A-Z</button>
				<button class="sort-btn" onclick="sortCommits('author', true)">Author Z-A</button>
			</div>
			<div class="search-options">
				<h2>Search Commits</h2>
				<input type="text" id="searchInput" placeholder="Enter search term">
				<select id="searchType">
					<option value="all">All Fields</option>
					<option value="message">Commit Message</option>
					<option value="author">Author</option>
					<option value="hash">Hash</option>
				</select>
				<button class="search-btn" onclick="searchCommits()">Search</button>
			</div>
			<div id="commits">
				${commits.all.map(commit => `
					<div class="commit" data-date="${commit.date}" data-author="${commit.author_name}">
						<div id="short-${commit.hash}" class="commit-short">
							<h3>${commit.message.split('\n')[0]}</h3>
							<span class="toggle-btn" onclick="toggleCommit('${commit.hash}')">Show more</span>
						</div>
						<div id="full-${commit.hash}" class="commit-full">
							<h3>${commit.message}</h3>
							<p>Author: ${commit.author_name}</p>
							<p>Date: ${new Date(commit.date).toLocaleString()}</p>
							<p>Hash: ${commit.hash}</p>
							<span class="toggle-btn" onclick="toggleCommit('${commit.hash}')">Show less</span>
						</div>
					</div>
				`).join('')}
			</div>
		</body>
		</html>
	`;
}

// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate
}
