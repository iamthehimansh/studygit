// Add these imports at the top
const vscode = require('vscode');
const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

// Add the getGit function
function getGit() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        throw new Error('No workspace folder open');
    }
    
    const workspacePath = workspaceFolders[0].uri.fsPath;
    return simpleGit(workspacePath);
}

// Add helper function for temp workspace
async function createTempWorkspace(git, commitHash) {
    const tempDir = path.join(os.tmpdir(), `studygit-${commitHash}`);
    
    try {
        // Clean up existing directory if it exists
        await cleanupTempWorkspace(tempDir);
        
        // Create temp directory
        await fs.mkdir(tempDir, { recursive: true });
        
        // Get the workspace folders
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            throw new Error('No workspace folder open');
        }

        // Get list of files in the commit
        const files = await git.raw(['ls-tree', '-r', '--name-only', commitHash]);
        const fileList = files.split('\n').filter(f => f.trim());

        // For each file in the commit
        for (const file of fileList) {
            try {
                // Get file content at this commit
                const content = await git.show([`${commitHash}:${file}`]);
                
                // Create directory structure if needed
                const filePath = path.join(tempDir, file);
                const fileDir = path.dirname(filePath);
                await fs.mkdir(fileDir, { recursive: true });
                
                // Write file content
                await fs.writeFile(filePath, content, 'utf8');
            } catch (error) {
                console.warn(`Warning: Could not create file ${file}:`, error);
                // Continue with other files
            }
        }
        
        return tempDir;
    } catch (error) {
        await cleanupTempWorkspace(tempDir);
        console.error('Full error:', error);
        throw new Error(`Failed to create temporary workspace: ${error.message}`);
    }
}

// Add cleanup function
async function cleanupTempWorkspace(tempDir) {
    try {
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log('Cleaned up temp directory:', tempDir);
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}

// Add commit selection function
async function selectCommit(commits) {
    const items = commits.all.map(commit => ({
        label: commit.message.split('\n')[0],
        description: `${commit.author_name} on ${new Date(commit.date).toLocaleString()}`,
        detail: commit.hash,
        commit: commit
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a commit to start playback from'
    });

    return selected ? selected.commit : null;
}

// Add decoration type creation function
function createDecorationTypes() {
    return {
        addition: vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(40, 167, 69, 0.2)',  // Softer green
            isWholeLine: true,
            overviewRulerColor: 'rgba(40, 167, 69, 0.8)',
            overviewRulerLane: vscode.OverviewRulerLane.Right
        }),
        deletion: vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(203, 36, 49, 0.2)',  // Softer red
            isWholeLine: true,
            overviewRulerColor: 'rgba(203, 36, 49, 0.8)',
            overviewRulerLane: vscode.OverviewRulerLane.Right
        }),
        modification: vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(227, 98, 9, 0.2)',   // Softer orange
            isWholeLine: true,
            overviewRulerColor: 'rgba(227, 98, 9, 0.8)',
            overviewRulerLane: vscode.OverviewRulerLane.Right
        }),
        cursor: vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(65, 132, 228, 0.5)',  // Soft blue cursor
            isWholeLine: false
        })
    };
}

// Add this at the top of your file to store decorations globally
const globalDecorationState = new Map(); // Store decorations by file URI

// Add at the top with other global variables
const workspacePlaybackPreferences = new Map(); // Store preferences by workspace

// Add at the top of your file
class PlaybackManager {
    constructor() {
        this.isPlaying = false;
        this.isPaused = false;
        this.currentCommitIndex = 0;
        this.commits = [];
        this.decorationStates = new Map();
        this.controls = this.createControls();
        this.currentPlayback = null;
        this.workspaceId = vscode.workspace.workspaceFolders?.[0].uri.toString();
        this.disposables = []; // Track command disposables
        this.registerCommands(); // Register commands on creation
        this.tempDirs = new Set(); // Track temp directories
        this.autoPlay = false;  // Flag to control auto-progression

        // Add tab change listener
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor) {
                    const state = this.getDecorationState(editor.document.uri);
                    this.applyDecorations(editor, state.decorationTypes, state);
                }
            })
        );
    }

    registerCommands() {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];

        this.disposables.push(
            vscode.commands.registerCommand('studygit.showPlaybackControls', () => this.showPlaybackControls()),
            vscode.commands.registerCommand('studygit.togglePlayback', () => this.togglePlayback()),
            vscode.commands.registerCommand('studygit.skipCommit', () => this.skipCommit()),
            vscode.commands.registerCommand('studygit.stopPlayback', () => this.stopPlayback())
        );
    }

    createControls() {
        // Create a container for all controls
        const container = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        container.text = "$(git-commit) Git Playback";
        container.backgroundColor = new vscode.ThemeColor('statusBarItem.debuggingBackground');

        // Create floating debug-like controls
        const controls = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
        controls.text = "$(debug-pause) $(debug-step-over) $(debug-stop)";
        controls.command = 'studygit.showPlaybackControls';
        controls.backgroundColor = new vscode.ThemeColor('statusBarItem.debuggingBackground');

        return { container, controls };
    }

    showControls() {
        Object.values(this.controls).forEach(control => control.show());
        this.updateStatus();
    }

    hideControls() {
        Object.values(this.controls).forEach(control => control.hide());
    }

    updateStatus() {
        if (!this.isPlaying) return;
        
        const commit = this.commits.all[this.currentCommitIndex];
        this.controls.container.text = `Commit ${this.currentCommitIndex + 1}/${this.commits.all.length}: ${commit.message.split('\n')[0]}`;
        this.controls.controls.text = this.isPaused ? "$(debug-start) $(debug-step-over) $(debug-stop)" : "$(debug-pause) $(debug-step-over) $(debug-stop)";
    }

    async togglePlayback() {
        this.isPaused = !this.isPaused;
        this.updateStatus();
        
        if (this.currentPlayback) {
            this.currentPlayback.isPaused = this.isPaused;
        }
    }

    async skipCommit() {
        if (this.currentPlayback) {
            this.currentPlayback.skip = true;
        }
        
        // Wait for current playback to finish
        while (this.currentPlayback) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Move to next commit if available
        if (this.currentCommitIndex < this.commits.all.length - 1) {
            this.currentCommitIndex++;
            await this.playCommit(this.git, this.commits.all[this.currentCommitIndex]);
        } else {
            vscode.window.showInformationMessage('No more commits to play');
        }
    }

    async stopPlayback() {
        this.isPlaying = false;
        this.isPaused = false;
        if (this.currentPlayback) {
            this.currentPlayback.stop = true;
        }

        // Cleanup all temp directories
        if (this.tempDirs) {
            for (const tempDir of this.tempDirs) {
                await cleanupTempWorkspace(tempDir);
            }
            this.tempDirs.clear();
        }

        // Clear all decorations
        this.decorationStates.forEach((state, uri) => {
            const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri);
            if (editor && state.decorationTypes) {
                editor.setDecorations(state.decorationTypes.addition, []);
                editor.setDecorations(state.decorationTypes.deletion, []);
                editor.setDecorations(state.decorationTypes.modification, []);
            }
        });
        this.decorationStates.clear();

        this.hideControls();
    }

    // Update startPlayback method
    async startPlayback(git, commits) {
        try {
            this.isPlaying = true;
            this.commits = commits;
            this.currentCommitIndex = 0;
            this.git = git;
            this.showControls();

            while (this.currentCommitIndex < commits.all.length && this.isPlaying) {
                const commit = commits.all[this.currentCommitIndex];
                
                // Show current commit info
                const commitMessage = commit.message.split('\n')[0];
                this.controls.container.text = `Playing commit ${this.currentCommitIndex + 1}/${commits.all.length}: ${commitMessage}`;
                
                const success = await this.playCommit(git, commit);
                
                if (!success || !this.isPlaying) {
                    break;
                }

                // Always ask for next commit
                if (this.currentCommitIndex < commits.all.length - 1) {
                    const nextCommit = commits.all[this.currentCommitIndex + 1];
                    const result = await vscode.window.showInformationMessage(
                        `Commit "${commitMessage}" completed.\n\nWould you like to continue to the next commit?\n\nNext: ${nextCommit.message.split('\n')[0]}`,
                        { modal: true },
                        'Continue', 'Take a Break', 'Stop'
                    );

                    if (result === 'Take a Break') {
                        await vscode.window.showInformationMessage(
                            'Press Continue when ready to proceed.',
                            { modal: true },
                            'Continue'
                        );
                        this.currentCommitIndex++;
                    } else if (result === 'Continue') {
                        this.currentCommitIndex++;
                    } else {
                        this.isPlaying = false;
                        break;
                    }
                } else {
                    await vscode.window.showInformationMessage('All commits completed!');
                    break;
                }
            }
        } finally {
            await this.cleanup();
        }
    }

    // Update playCommit method
    async playCommit(git, commit) {
        const tempDir = await createTempWorkspace(git, commit.hash);
        this.tempDirs.add(tempDir);

        try {
            const changedFiles = await getChangedFilesWithDiff(git, commit.hash);
            const totalFiles = changedFiles.length;
            
            this.currentPlayback = {
                isPaused: this.isPaused,
                skip: false,
                stop: false
            };

            for (let fileIndex = 0; fileIndex < changedFiles.length; fileIndex++) {
                const file = changedFiles[fileIndex];
                if (this.currentPlayback?.stop) break;

                try {
                    const filePath = path.join(tempDir, file.path);
                    if (!await fileExists(filePath)) {
                        console.warn(`File not found: ${file.path}`);
                        continue;
                    }

                    const doc = await vscode.workspace.openTextDocument(filePath);
                    const editor = await vscode.window.showTextDocument(doc, {
                        preview: false,
                        viewColumn: vscode.ViewColumn.One
                    });

                    await this.playbackFile(editor, file);
                } catch (error) {
                    console.error(`Error with file ${file.path}:`, error);
                    if (!await this.promptToContinue(error)) {
                        return false;
                    }
                }
            }
            return true;
        } catch (error) {
            console.error('Error in playCommit:', error);
            return false;
        }
    }

    // Add skip method
    skip() {
        if (this.currentPlayback) {
            this.currentPlayback.skip = true;
        }
    }

    async playbackFile(editor, file) {
        try {
            const decorations = createDecorationTypes();
            const decorationState = this.getDecorationState(editor.document.uri);
            let typingSpeed = vscode.workspace.getConfiguration('studygit').get('playbackSpeed', 50);

            // First pass: Handle all deletions
            const linesToProcess = new Set();
            
            for (const change of file.changes) {
                if (change.type === 'delete' || change.type === 'insert') {
                    const lineNumber = change.type === 'delete' ? 
                        change.range.start.line : 
                        change.position.line;
                    linesToProcess.add(lineNumber);
                }
            }

            // Delete content from all lines that will be modified
            for (const lineNumber of linesToProcess) {
                try {
                    const currentLine = editor.document.lineAt(lineNumber);
                    if (currentLine && currentLine.text.length > 0) {
                        const deleteRange = new vscode.Range(
                            lineNumber, 0,
                            lineNumber, currentLine.text.length
                        );

                        // Show deletion highlight
                        decorationState.deletions.push(deleteRange);
                        this.applyDecorations(editor, decorations, decorationState);
                        editor.revealRange(deleteRange, vscode.TextEditorRevealType.InCenter);
                        
                        // Delete the entire line content
                        await editor.edit(editBuilder => {
                            editBuilder.delete(deleteRange);
                        });

                        // Wait for deletion to complete
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                } catch (error) {
                    console.error(`Error deleting line ${lineNumber}:`, error);
                }
            }

            // Second pass: Handle insertions
            const processedLines = new Set();

            for (const change of file.changes) {
                if (this.currentPlayback?.skip) break;

                if (change.type === 'insert') {
                    const lineNumber = change.position.line;
                    
                    // Skip if we've already processed this line
                    if (processedLines.has(lineNumber)) continue;
                    processedLines.add(lineNumber);

                    try {
                        let currentPosition = new vscode.Position(
                            lineNumber,
                            change.position.character
                        );

                        // Type the text exactly as it is
                        for (const char of change.text) {
                            if (this.currentPlayback?.skip) break;
                            while (this.currentPlayback?.isPaused) {
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }

                            await editor.edit(editBuilder => {
                                editBuilder.insert(currentPosition, char);
                            });
                            
                            currentPosition = new vscode.Position(
                                currentPosition.line,
                                currentPosition.character + 1
                            );
                            
                            editor.selection = new vscode.Selection(currentPosition, currentPosition);
                            editor.revealRange(
                                new vscode.Range(currentPosition, currentPosition),
                                vscode.TextEditorRevealType.InCenterIfOutsideViewport
                            );
                            
                            const charSpeed = typingSpeed * (char === ' ' || char === '\t' ? 
                                0.5 : (0.8 + Math.random() * 0.4));
                            await new Promise(resolve => setTimeout(resolve, charSpeed));
                        }

                        const insertedRange = new vscode.Range(
                            new vscode.Position(lineNumber, change.position.character),
                            currentPosition
                        );
                        decorationState.additions.push(insertedRange);
                        this.applyDecorations(editor, decorations, decorationState);
                    }
                    catch (error) {
                        console.error(`Error inserting at line ${lineNumber}:`, error);
                    }
                }
            }

            return !this.currentPlayback?.skip;
        } catch (error) {
            console.error('Error in playbackFile:', error);
            return false;
        }
    }

    // Update the skip button handler
    setupSkipButton() {
        this.controls.skip.command = 'studygit.skip';
        this.controls.skip.text = '$(debug-step-over) Skip';
        this.controls.skip.tooltip = 'Skip to next file';
        this.controls.skip.show();

        return vscode.commands.registerCommand('studygit.skip', () => {
            this.skip();
        });
    }

    // Add method to handle errors
    async promptToContinue(error) {
        const result = await vscode.window.showErrorMessage(
            `Error during playback: ${error.message}`,
            { modal: true },
            'Continue', 'Stop'
        );
        return result === 'Continue';
    }

    async isBinaryFile(filePath) {
        try {
            const buffer = await fs.readFile(filePath);
            // Check for null bytes or non-text characters
            for (let i = 0; i < Math.min(buffer.length, 8000); i++) {
                const byte = buffer[i];
                if (byte === 0 || (byte < 7 && byte !== 4)) {
                    return true;
                }
            }
            return false;
        } catch (error) {
            console.error('Error checking file type:', error);
            return true; // Assume binary if can't read
        }
    }

    getDecorationState(uri) {
        const key = uri.toString();
        if (!this.decorationStates.has(key)) {
            this.decorationStates.set(key, {
                additions: [],
                deletions: [],
                modifications: [], // Add modifications array
                decorationTypes: createDecorationTypes()
            });
        }
        return this.decorationStates.get(key);
    }

    applyDecorations(editor, decorations, state) {
        const uri = editor.document.uri.toString();
        
        // Clear existing decorations
        if (state.decorationTypes) {
            editor.setDecorations(state.decorationTypes.addition, []);
            editor.setDecorations(state.decorationTypes.deletion, []);
            editor.setDecorations(state.decorationTypes.modification, []);
        }

        // Apply new decorations
        editor.setDecorations(decorations.addition, state.additions || []);
        editor.setDecorations(decorations.deletion, state.deletions || []);
        editor.setDecorations(decorations.modification, state.modifications || []);
        
        state.decorationTypes = decorations;
    }

    async promptForNextCommit() {
        const nextCommit = this.commits.all[this.currentCommitIndex + 1];
        if (!nextCommit) {
            vscode.window.showInformationMessage('No more commits to play');
            return false;
        }

        const result = await vscode.window.showInformationMessage(
            `Current commit completed. Would you like to play the next commit?\n\nNext commit: ${nextCommit.message.split('\n')[0]}`,
            { modal: true },
            'Play Next', 'Take a Break', 'Stop Here'
        );

        if (result === 'Take a Break') {
            await vscode.window.showInformationMessage(
                'Press Continue when ready to proceed.',
                { modal: true },
                'Continue'
            );
            return true;
        }

        return result === 'Play Next';
    }

    async promptForNextFile(currentFile, totalFiles, commitInfo) {
        if (this.autoPlay) return true;

        const items = [
            {
                label: '$(play) Continue to Next File',
                description: `File ${currentFile}/${totalFiles} in commit: ${commitInfo}`,
                value: 'next'
            },
            {
                label: '$(debug-pause) Take a Break',
                description: 'Pause here to read the changes',
                value: 'pause'
            },
            {
                label: '$(settings-gear) Auto-play Remaining',
                description: 'Continue without prompting',
                value: 'auto'
            }
        ];

        const result = await vscode.window.showInformationMessage(
            `Finished file ${path.basename(currentFile)}. Ready for next file?`,
            { modal: false },
            'Continue', 'Auto-play', 'Take a Break'
        );

        if (result === 'Auto-play') {
            this.autoPlay = true;
            return true;
        } else if (result === 'Take a Break') {
            await vscode.window.showInformationMessage(
                'Press Continue when ready to proceed.',
                { modal: true },
                'Continue'
            );
            return true;
        }
        return result === 'Continue';
    }

    async getPlaybackPreference() {
        const config = vscode.workspace.getConfiguration('studygit');
        const savedPreferences = config.get('playbackPreferences') || {};
        return savedPreferences[this.workspaceId];
    }

    async savePlaybackPreference(preference) {
        const config = vscode.workspace.getConfiguration('studygit');
        const savedPreferences = config.get('playbackPreferences') || {};
        savedPreferences[this.workspaceId] = preference;
        await config.update('playbackPreferences', savedPreferences, vscode.ConfigurationTarget.Global);
    }

    async showPlaybackControls() {
        const items = [
            {
                label: this.isPaused ? '$(debug-start) Resume' : '$(debug-pause) Pause',
                description: 'Toggle playback pause state',
                action: 'toggle'
            },
            {
                label: '$(debug-step-over) Skip',
                description: 'Skip to next commit',
                action: 'skip'
            },
            {
                label: '$(debug-stop) Stop',
                description: 'Stop playback and cleanup',
                action: 'stop'
            }
        ];

        const result = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select playback action',
            ignoreFocusOut: true
        });

        if (result) {
            switch (result.action) {
                case 'toggle': await this.togglePlayback(); break;
                case 'skip': await this.skipCommit(); break;
                case 'stop': await this.stopPlayback(); break;
            }
        }
    }

    // Add cleanup method
    async cleanup() {
        this.isPlaying = false;
        if (this.currentPlayback) {
            this.currentPlayback.stop = true;
        }
        
        // Hide controls
        this.hideControls();
        
        // Cleanup temp directories
        if (this.tempDirs) {
            for (const tempDir of this.tempDirs) {
                await cleanupTempWorkspace(tempDir);
            }
            this.tempDirs.clear();
        }
    }

    dispose() {
        this.disposables.forEach(d => d.dispose());
        Object.values(this.controls).forEach(control => control.dispose());
        this.decorationStates.clear();
    }
}

// Create a single instance of the manager
const playbackManager = new PlaybackManager();

// Update the extension activation
function activate(context) {
    // Add Git exclusion configuration
    vscode.workspace.getConfiguration('git').update('ignoredWorkspaces', [
        '**/studygit-*'
    ], vscode.ConfigurationTarget.Global);

    context.subscriptions.push(
        vscode.commands.registerCommand('studygit.startPlayback', async () => {
            try {
                const git = getGit();
                const commits = await git.log();
                
                const selectedCommit = await selectCommit(commits);
                if (!selectedCommit) {
                    return;
                }

                const startIndex = commits.all.findIndex(c => c.hash === selectedCommit.hash);
                if (startIndex !== -1) {
                    commits.all = commits.all.slice(startIndex);
                }

                await playbackManager.startPlayback(git, commits);
            } catch (error) {
                console.error('Playback error:', error);
                vscode.window.showErrorMessage(`Failed to start playback: ${error.message}`);
            }
        })
    );

    // Add playbackManager to subscriptions for cleanup
    context.subscriptions.push({ dispose: () => playbackManager.dispose() });
}

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

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
// function activate(context) {
// 	context.subscriptions.push(analyzeHistory, playbackManager);
// }

// Add this function to create decorations
// function createDecorationTypes() {
//     return {
//         addition: vscode.window.createTextEditorDecorationType({
//             backgroundColor: 'rgba(0, 255, 0, 0.2)',
//             isWholeLine: true,
//             overviewRulerColor: 'rgba(0, 255, 0, 0.8)',
//             overviewRulerLane: vscode.OverviewRulerLane.Right
//         }),
//         deletion: vscode.window.createTextEditorDecorationType({
//             backgroundColor: 'rgba(255, 0, 0, 0.2)',
//             isWholeLine: true,
//             overviewRulerColor: 'rgba(255, 0, 0, 0.8)',
//             overviewRulerLane: vscode.OverviewRulerLane.Right
//         }),
//         cursor: vscode.window.createTextEditorDecorationType({
//             backgroundColor: 'rgba(255, 255, 0, 0.3)',
//             isWholeLine: true,
//             overviewRulerColor: 'rgba(255, 255, 0, 0.8)',
//             overviewRulerLane: vscode.OverviewRulerLane.Center
//         })
//     };
// }

// Update the playbackCode function to handle new files
async function playbackCode(editor, speed, changes, isNewFile) {
    // If it's a new file, clear the content first
    if (isNewFile) {
        const fullRange = new vscode.Range(
            0, 0,
            editor.document.lineCount - 1,
            editor.document.lineAt(editor.document.lineCount - 1).text.length
        );
        
        await editor.edit(editBuilder => {
            editBuilder.delete(fullRange);
        });
    }

    const documentUri = editor.document.uri.toString();
    const decorations = createDecorationTypes();
    
    // Initialize or get existing decoration state for this document
    if (!globalDecorationState.has(documentUri)) {
        globalDecorationState.set(documentUri, {
            additions: [],
            deletions: [],
            currentCursor: null,
            decorationTypes: decorations
        });
    }
    const decorationState = globalDecorationState.get(documentUri);

    const playbackControls = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    const replayButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    
    // Create unique command IDs for this instance
    const toggleCommandId = `studygit.togglePlayback.${Date.now()}`;
    const replayCommandId = `studygit.replayChanges.${Date.now()}`;
    
    playbackControls.text = "$(debug-pause) Pause | $(chevron-left) Back | $(chevron-right) Forward";
    playbackControls.command = toggleCommandId;
    replayButton.text = "$(debug-restart) Replay";
    replayButton.command = replayCommandId;
    
    playbackControls.show();
    replayButton.show();

    let isPaused = false;
    let currentChangeIndex = 0;
    let isPlaybackActive = true;

    // Function to apply all decorations
    function applyDecorations(targetEditor) {
        if (!targetEditor || targetEditor.document.uri.toString() !== documentUri) return;
        
        targetEditor.setDecorations(decorations.addition, decorationState.additions);
        targetEditor.setDecorations(decorations.deletion, decorationState.deletions);
        if (decorationState.currentCursor) {
            targetEditor.setDecorations(decorations.cursor, [decorationState.currentCursor]);
        }
    }

    // Register tab change listener
    const tabChangeListener = vscode.window.onDidChangeActiveTextEditor(activeEditor => {
        if (activeEditor && activeEditor.document.uri.toString() === documentUri) {
            applyDecorations(activeEditor);
        }
    });

    // Register control commands with unique IDs
    let togglePause = vscode.commands.registerCommand(toggleCommandId, () => {
        isPaused = !isPaused;
        playbackControls.text = isPaused ? 
            "$(debug-start) Play | $(chevron-left) Back | $(chevron-right) Forward" :
            "$(debug-pause) Pause | $(chevron-left) Back | $(chevron-right) Forward";
    });

    // Register replay command with unique ID
    let replayChanges = vscode.commands.registerCommand(replayCommandId, async () => {
        try {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) {
                vscode.window.showErrorMessage('No active editor for replay');
                return;
            }

            // Clear existing content
            const fullRange = new vscode.Range(
                0, 0,
                activeEditor.document.lineCount - 1,
                activeEditor.document.lineAt(activeEditor.document.lineCount - 1).text.length
            );
            
            await activeEditor.edit(editBuilder => {
                editBuilder.delete(fullRange);
            });

            // Reset decoration state
            decorationState.additions = [];
            decorationState.deletions = [];
            decorationState.currentCursor = null;
            applyDecorations(activeEditor);

            // Replay changes
            currentChangeIndex = 0;
            isPlaybackActive = true;
            isPaused = false;
            await playChanges(activeEditor);
        } catch (error) {
            console.error('Replay error:', error);
            vscode.window.showErrorMessage('Failed to replay changes: ' + error.message);
        }
    });

    async function playChanges(activeEditor) {
        try {
            while (currentChangeIndex < changes.length && isPlaybackActive) {
                if (!isPaused) {
                    const change = changes[currentChangeIndex];
                    
                    if (change.type === 'delete') {
                        decorationState.deletions.push(change.range);
                        decorationState.currentCursor = change.range;
                        
                        await activeEditor.edit(editBuilder => {
                            editBuilder.delete(change.range);
                        });
                    } else if (change.type === 'insert') {
                        await activeEditor.edit(editBuilder => {
                            editBuilder.insert(change.position, change.text);
                        });

                        // Only highlight if it's not a replacement of deleted content
                        if (!change.isReplacement) {
                            const insertedRange = new vscode.Range(
                                change.position,
                                new vscode.Position(
                                    change.position.line + (change.text.match(/\n/g) || []).length,
                                    change.text.includes('\n') 
                                        ? change.text.substring(change.text.lastIndexOf('\n') + 1).length 
                                        : change.position.character + change.text.length
                                )
                            );
                            decorationState.additions.push(insertedRange);
                        }
                        decorationState.currentCursor = new vscode.Range(change.position, change.position);
                    }

                    applyDecorations(activeEditor);
                    
                    // Reveal the current change
                    activeEditor.revealRange(
                        decorationState.currentCursor,
                        vscode.TextEditorRevealType.InCenter
                    );

                    await new Promise(resolve => setTimeout(resolve, speed));
                    currentChangeIndex++;
                } else {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
        } finally {
            decorationState.currentCursor = null;
            applyDecorations(activeEditor);
        }
    }

    // Start initial playback
    await playChanges(editor);

    // Register decoration persistence
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document === editor.document) {
            applyDecorations(editor);
        }
    });

    return { 
        playbackControls, 
        replayButton, 
        togglePause, 
        replayChanges, 
        decorations,
        toggleCommandId,
        replayCommandId,
        changeDocumentSubscription,
        tabChangeListener, // Add this
        decorationState,
        documentUri // Add this
    };
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

// Add this new function to handle commit selection
// async function selectCommit(commits) {
//     const items = commits.all.map(commit => ({
//         label: commit.message.split('\n')[0],
//         description: `${commit.author_name} on ${new Date(commit.date).toLocaleString()}`,
//         detail: commit.hash,
//         commit: commit
//     }));

//     const selected = await vscode.window.showQuickPick(items, {
//         placeHolder: 'Select a commit to start playback from'
//     });

//     return selected ? selected.commit : null;
// }

// Add this function to handle cleanup
// async function cleanupTempWorkspace(tempDir) {
//     try {
//         await fs.rm(tempDir, { recursive: true, force: true });
//         console.log('Cleaned up temp directory:', tempDir);
//     } catch (error) {
//         console.error('Cleanup error:', error);
//     }
// }

// Update the createTempWorkspace function
// async function createTempWorkspace(git, commitHash) {
//     const tempDir = path.join(os.tmpdir(), `studygit-${commitHash}`);
    
//     try {
//         // Clean up existing directory if it exists
//         await cleanupTempWorkspace(tempDir);
        
//         // Create temp directory
//         await fs.mkdir(tempDir, { recursive: true });
        
//         // Get the workspace folders
//         const workspaceFolders = vscode.workspace.workspaceFolders;
//         if (!workspaceFolders) {
//             throw new Error('No workspace folder open');
//         }
        
//         const localRepoPath = workspaceFolders[0].uri.fsPath;
//         const absolutePath = path.resolve(localRepoPath);
//        
//         // Clone without git initialization
//         await git.raw(['archive', commitHash, '--format=tar'])
//             .then(buffer => new Promise((resolve, reject) => {
//                 const extract = require('tar').extract({
//                     cwd: tempDir,
//                     strict: true
//                 });
//                 extract.on('error', reject);
//                 extract.on('end', resolve);
                
//                 const stream = require('stream');
//                 const bufferStream = new stream.PassThrough();
//                 bufferStream.end(Buffer.from(buffer, 'binary'));
//                 bufferStream.pipe(extract);
//             }));
        
//         return tempDir;
//     } catch (error) {
//         await cleanupTempWorkspace(tempDir);
//         console.error('Full error:', error);
//         throw new Error(`Failed to create temporary workspace: ${error.message}`);
//     }
// }

// Update getChangedFilesWithDiff to better handle file paths
async function getChangedFilesWithDiff(git, commitHash) {
    try {
        const diff = await git.show([
            commitHash,
            '--format=', 
            '--patch',   
            '-U0'       
        ]);

        const files = [];
        let currentFile = null;
        let currentHunk = null;

        const lines = diff.split('\n');
        for (const line of lines) {
            if (line.startsWith('diff --git')) {
                if (currentFile) {
                    files.push(currentFile);
                }
                // Extract clean file path
                const filePath = line.split(' b/')[1];
                if (!filePath) continue; // Skip if path is invalid
                
                currentFile = {
                    path: filePath.trim(),
                    changes: []
                };
            } else if (line.startsWith('+++') || line.startsWith('---')) {
                // Skip these lines completely
                continue;
            } else if (line.startsWith('@@ ')) {
                const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
                if (match) {
                    currentHunk = {
                        oldStart: parseInt(match[1]),
                        newStart: parseInt(match[2])
                    };
                }
            } else if (currentFile && currentHunk && line.length > 0 && !line.startsWith('\\')) {
                // Only process actual content lines
                if (line.startsWith('+') || line.startsWith('-')) {
                    const cleanLine = line.substring(1); // Remove just the first character
                    
                    if (line.startsWith('-')) {
                        currentFile.changes.push({
                            type: 'delete',
                            range: new vscode.Range(
                                currentHunk.oldStart - 1, 0,
                                currentHunk.oldStart - 1, cleanLine.length
                            ),
                            text: cleanLine
                        });
                        currentHunk.oldStart++;
                    } else if (line.startsWith('+')) {
                        currentFile.changes.push({
                            type: 'insert',
                            position: new vscode.Position(currentHunk.newStart - 1, 0),
                            text: cleanLine
                        });
                        currentHunk.newStart++;
                    }
                } else {
                    currentHunk.oldStart++;
                    currentHunk.newStart++;
                }
            }
        }

        if (currentFile) {
            files.push(currentFile);
        }

        return files;
    } catch (error) {
        console.error('Error getting changed files:', error);
        throw error;
    }
}

// Add this function to handle user preferences
async function getPlaybackPreference(workspaceId) {
    const config = vscode.workspace.getConfiguration('studygit');
    const savedPreferences = config.get('playbackPreferences') || {};
    return savedPreferences[workspaceId];
}

async function savePlaybackPreference(workspaceId, preference) {
    const config = vscode.workspace.getConfiguration('studygit');
    const savedPreferences = config.get('playbackPreferences') || {};
    savedPreferences[workspaceId] = preference;
    await config.update('playbackPreferences', savedPreferences, vscode.ConfigurationTarget.Global);
}

// Add this function to prompt for next commit
async function promptForNextCommit(currentCommitIndex, commits, workspaceId) {
    const preference = await getPlaybackPreference(workspaceId);
    
    if (preference === 'always') {
        return true;
    } else if (preference === 'never') {
        return false;
    }

    const nextCommit = commits.all[currentCommitIndex + 1];
    if (!nextCommit) {
        vscode.window.showInformationMessage('No more commits to play');
        return false;
    }

    const items = [
        {
            label: '$(play) Play Next Commit',
            description: `${nextCommit.message.split('\n')[0]}`,
            value: true
        },
        {
            label: '$(stop) Stop Playback',
            description: 'End the playback session',
            value: false
        }
    ];

    const rememberItems = [
        {
            label: "Remember my choice for this workspace",
            picked: false
        }
    ];

    const result = await vscode.window.showQuickPick(items, {
        placeHolder: 'Would you like to play the next commit?',
        canPickMany: false,
        ignoreFocusOut: true
    });

    if (!result) {
        return false;
    }

    // Ask if user wants to remember choice
    const remember = await vscode.window.showQuickPick([
        { label: 'Yes, remember my choice', value: true },
        { label: 'No, ask me each time', value: false }
    ], {
        placeHolder: 'Would you like to remember this choice for this workspace?',
        ignoreFocusOut: true
    });

    if (remember?.value) {
        await savePlaybackPreference(workspaceId, result.value ? 'always' : 'never');
    }

    return result.value;
}

// Add helper function to check file existence
async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}
// This method is called when your extension is deactivated
function deactivate() {
    globalDecorationState.clear();
}

module.exports = {
	activate,
	deactivate
}

