import { App, Plugin, Notice, PluginSettingTab, Setting, MarkdownView, WorkspaceLeaf } from 'obsidian';

interface LaserPointerSettings {
    laserColor: string;
    trailDuration: number;
    strokeWidth: number;
    strokeHardness: number;
    persistTrails: boolean;
    rememberDrawings: boolean;
    autoReadingMode: boolean;
    showToolbarHeader: boolean;
    showColorPresets: boolean;
    showCustomColor: boolean;
    showWidthSlider: boolean;
    showHardnessSlider: boolean;
    showEraserButton: boolean;
    showClearButton: boolean;
    showPersistToggle: boolean;
    showRememberToggle: boolean;
}

interface SavedPath {
    d: string;
    stroke: string;
    strokeWidth: string;
    strokeOpacity: string;
    filter: string;
}

interface PersistedData extends Partial<LaserPointerSettings> {
    _savedPaths?: SavedPath[];
}

// Keys of LaserPointerSettings whose value type is boolean.
type BooleanSettingKey = {
    [K in keyof LaserPointerSettings]: LaserPointerSettings[K] extends boolean ? K : never;
}[keyof LaserPointerSettings];

const DEFAULT_SETTINGS: LaserPointerSettings = {
    laserColor: '#ff1a1a',
    trailDuration: 4,
    strokeWidth: 3,
    strokeHardness: 1.0,
    persistTrails: false,
    rememberDrawings: false,
    autoReadingMode: true,
    showToolbarHeader: true,
    showColorPresets: true,
    showCustomColor: true,
    showWidthSlider: true,
    showHardnessSlider: true,
    showEraserButton: true,
    showClearButton: true,
    showPersistToggle: true,
    showRememberToggle: true,
};

const PRESET_COLORS = [
    { color: '#ff1a1a', label: 'Red' },
    { color: '#ff9800', label: 'Orange' },
    { color: '#ffeb3b', label: 'Yellow' },
    { color: '#00e676', label: 'Green' },
    { color: '#2196f3', label: 'Blue' },
    { color: '#9c27b0', label: 'Purple' },
    { color: '#e91e63', label: 'Pink' },
    { color: '#795548', label: 'Brown' },
    { color: '#9e9e9e', label: 'Gray' },
    { color: '#212121', label: 'Black' },
    { color: '#ffffff', label: 'White' },
];

export default class LaserPointerPlugin extends Plugin {
    settings: LaserPointerSettings;
    private isActive: boolean = false;
    private laserPointer: HTMLElement | null = null;
    private svgContainer: SVGSVGElement | null = null;
    private currentPath: SVGPathElement | null = null;
    private isDrawing: boolean = false;
    private points: string[] = [];
    private lastMouseX: number = 0;
    private lastMouseY: number = 0;
    private boundOnContextMenu: (evt: MouseEvent) => void;
    private boundOnSvgClick: (evt: MouseEvent) => void;

    savedPaths: SavedPath[] = [];

    private toolbar: HTMLElement | null = null;
    private isDraggingToolbar: boolean = false;
    private dragOffsetX: number = 0;
    private dragOffsetY: number = 0;

    private isEraserMode: boolean = false;
    private eraserBtn: HTMLElement | null = null;

    private originalMode: string | null = null;
    private targetLeaf: WorkspaceLeaf | null = null;

    async onload() {
        await this.loadSettings();
        this.boundOnContextMenu = this.handleContextMenu.bind(this);
        this.boundOnSvgClick = this.onSvgClick.bind(this);

        this.addRibbonIcon('target', 'Toggle Laser Pointer', () => {
            this.toggleLaser();
        });

        this.addCommand({
            id: 'toggle',
            name: 'Toggle',
            callback: () => {
                this.toggleLaser();
            }
        });

        this.addSettingTab(new LaserPointerSettingTab(this.app, this));

        this.registerDomEvent(document, 'mousemove', (evt: MouseEvent) => {
            this.lastMouseX = evt.clientX;
            this.lastMouseY = evt.clientY;

            if (this.isDraggingToolbar && this.toolbar) {
                this.toolbar.style.left = `${evt.clientX - this.dragOffsetX}px`;
                this.toolbar.style.top = `${evt.clientY - this.dragOffsetY}px`;
                return;
            }

            if (!this.isActive || !this.laserPointer) return;
            this.laserPointer.style.left = `${evt.clientX}px`;
            this.laserPointer.style.top = `${evt.clientY}px`;

            if (this.isDrawing && this.currentPath) {
                this.points.push(`${evt.clientX},${evt.clientY}`);
                this.currentPath.setAttribute('d', `M ${this.points.join(' L ')}`);
            }
        });

        this.registerDomEvent(document, 'mousedown', this.onMouseDown.bind(this));
        this.registerDomEvent(document, 'mouseup', this.onMouseUp.bind(this));

        this.registerDomEvent(document, 'keydown', (evt: KeyboardEvent) => {
            if (evt.key === 'Escape' && this.isActive) {
                evt.preventDefault();
                evt.stopPropagation();
                this.deactivateLaser();
                new Notice('⚫ Laser Pointer deactivated');
            }
        });
    }

    async loadSettings() {
        const data = (await this.loadData()) as PersistedData | null;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
        this.savedPaths = data?._savedPaths ?? [];
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    toggleLaser() {
        this.isActive = !this.isActive;
        if (this.isActive) {
            this.activateLaser();
            new Notice('🔴 Laser Pointer activated');
        } else {
            this.deactivateLaser();
            new Notice('⚫ Laser Pointer deactivated');
        }
    }

    activateLaser() {
        document.body.addClass('laser-cursor-hidden');
        window.addEventListener('contextmenu', this.boundOnContextMenu, true);

        if (this.settings.autoReadingMode) {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view) {
                const leaf = view.leaf;
                const state = leaf.getViewState();
                if (state.state?.mode !== 'preview') {
                    this.originalMode = (state.state as { mode?: string } | undefined)?.mode || 'source';
                    this.targetLeaf = leaf;
                    void leaf.setViewState({
                        type: 'markdown',
                        state: { ...state.state, mode: 'preview' }
                    });
                }
            }
        }

        this.laserPointer = document.body.createDiv('laser-pointer');
        this.applyLaserColor(this.settings.laserColor);
        this.laserPointer.style.left = `${this.lastMouseX}px`;
        this.laserPointer.style.top = `${this.lastMouseY}px`;

        this.svgContainer = document.body.createSvg('svg', { cls: 'laser-svg-container' });
        this.svgContainer.addEventListener('click', this.boundOnSvgClick);

        if (this.settings.rememberDrawings && this.savedPaths.length > 0) {
            this.savedPaths.forEach((saved) => {
                const path = this.svgContainer!.createSvg('path', { cls: 'laser-path' });
                path.setAttribute('d', saved.d);
                path.style.stroke = saved.stroke;
                path.style.strokeWidth = saved.strokeWidth;
                path.style.strokeOpacity = saved.strokeOpacity;
                path.style.filter = saved.filter;
            });
        }

        this.createToolbar();
    }

    deactivateLaser() {
        this.isActive = false;
        this.isEraserMode = false;
        document.body.removeClass('laser-cursor-hidden');
        window.removeEventListener('contextmenu', this.boundOnContextMenu, true);

        if (this.targetLeaf && this.originalMode) {
            try {
                const state = this.targetLeaf.getViewState();
                void this.targetLeaf.setViewState({
                    type: 'markdown',
                    state: { ...state.state, mode: this.originalMode }
                });
            } catch {
                // ignore
            }
            this.originalMode = null;
            this.targetLeaf = null;
        }

        if (this.settings.rememberDrawings && this.svgContainer) {
            this.savedPaths = [];
            this.svgContainer.querySelectorAll('.laser-path').forEach((pathEl) => {
                const p = pathEl as SVGPathElement;
                this.savedPaths.push({
                    d: p.getAttribute('d') || '',
                    stroke: p.style.stroke,
                    strokeWidth: p.style.strokeWidth,
                    strokeOpacity: p.style.strokeOpacity || '1',
                    filter: p.style.filter,
                });
            });
            void this.saveData({ ...this.settings, _savedPaths: this.savedPaths });
        } else {
            this.savedPaths = [];
            void this.saveData({ ...this.settings, _savedPaths: [] });
        }

        if (this.laserPointer) {
            this.laserPointer.remove();
            this.laserPointer = null;
        }
        if (this.svgContainer) {
            this.svgContainer.removeEventListener('click', this.boundOnSvgClick);
            this.svgContainer.remove();
            this.svgContainer = null;
        }
        if (this.toolbar) {
            this.toolbar.remove();
            this.toolbar = null;
        }
        this.eraserBtn = null;
        this.isDrawing = false;
        this.isDraggingToolbar = false;
        this.currentPath = null;
        this.points = [];
    }

    createToolbar() {
        this.toolbar = document.body.createDiv('laser-toolbar');

        if (this.settings.showToolbarHeader) {
            const header = this.toolbar.createDiv({ cls: 'laser-toolbar-header', text: 'Laser Pointer' });
            header.addEventListener('mousedown', (evt) => {
                if (!this.toolbar) return;
                this.isDraggingToolbar = true;
                if (this.laserPointer) {
                    this.laserPointer.addClass('laser-pointer-hidden');
                }
                const rect = this.toolbar.getBoundingClientRect();
                this.toolbar.style.left = `${rect.left}px`;
                this.toolbar.style.top = `${rect.top}px`;
                this.toolbar.addClass('laser-toolbar-dragging');
                this.dragOffsetX = evt.clientX - rect.left;
                this.dragOffsetY = evt.clientY - rect.top;
                evt.preventDefault();
                evt.stopPropagation();
            });
        }

        if (this.settings.showColorPresets || this.settings.showCustomColor) {
            const colorRow = this.toolbar.createDiv('laser-toolbar-colors');

            if (this.settings.showColorPresets) {
                PRESET_COLORS.forEach(preset => {
                    const btn = colorRow.createEl('button', {
                        cls: 'laser-color-btn',
                        attr: { 'data-color': preset.color, 'aria-label': preset.label }
                    });
                    btn.style.backgroundColor = preset.color;
                    if (this.settings.laserColor === preset.color) btn.addClass('active');

                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.setLaserColor(preset.color);
                        colorRow.querySelectorAll('.laser-color-btn').forEach(b => b.removeClass('active'));
                        btn.addClass('active');
                    });
                });
            }

            if (this.settings.showCustomColor) {
                const customBtn = colorRow.createEl('button', {
                    cls: 'laser-color-btn laser-color-custom',
                    attr: { 'aria-label': 'Custom color' },
                    text: '🎨'
                });

                const colorInput = colorRow.createEl('input', {
                    type: 'color',
                    cls: 'laser-color-picker-hidden'
                });
                colorInput.value = this.settings.laserColor;

                customBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    colorInput.click();
                });

                colorInput.addEventListener('input', (e) => {
                    const color = (e.target as HTMLInputElement).value;
                    this.setLaserColor(color);
                    colorRow.querySelectorAll('.laser-color-btn').forEach(b => b.removeClass('active'));
                });
            }
        }

        if (this.settings.showWidthSlider) {
            const widthRow = this.toolbar.createDiv('laser-toolbar-width');

            const widthLabel = widthRow.createEl('label', { text: `Width: ${this.settings.strokeWidth}px` });

            const slider = widthRow.createEl('input', {
                type: 'range',
                cls: 'laser-width-slider',
                attr: { min: '0.5', max: '20', step: '0.5' }
            });
            slider.value = String(this.settings.strokeWidth);

            slider.addEventListener('input', (e) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                this.settings.strokeWidth = val;
                void this.saveSettings();
                widthLabel.setText(`Width: ${val}px`);
            });
        }

        if (this.settings.showHardnessSlider) {
            const hardnessRow = this.toolbar.createDiv('laser-toolbar-hardness');

            const hardnessLabel = hardnessRow.createEl('label', {
                text: `Hard: ${Math.round(this.settings.strokeHardness * 100)}%`
            });

            const hardnessSlider = hardnessRow.createEl('input', {
                type: 'range',
                cls: 'laser-width-slider',
                attr: { min: '0.1', max: '1', step: '0.1' }
            });
            hardnessSlider.value = String(this.settings.strokeHardness);

            hardnessSlider.addEventListener('input', (e) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                this.settings.strokeHardness = val;
                void this.saveSettings();
                hardnessLabel.setText(`Hard: ${Math.round(val * 100)}%`);
            });
        }

        if (this.settings.showEraserButton || this.settings.showClearButton) {
            const actionsRow = this.toolbar.createDiv('laser-toolbar-actions');

            if (this.settings.showEraserButton) {
                this.eraserBtn = actionsRow.createEl('button', {
                    cls: 'laser-action-btn',
                    attr: { 'aria-label': 'Eraser' },
                    text: '🧽'
                });
                this.eraserBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleEraserMode();
                });
            }

            if (this.settings.showClearButton) {
                const clearBtn = actionsRow.createEl('button', {
                    cls: 'laser-action-btn',
                    attr: { 'aria-label': 'Clear all trails' },
                    text: '🗑️'
                });
                clearBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.clearAllPaths();
                });
            }
        }

        if (this.settings.showPersistToggle) {
            const persistRow = this.toolbar.createDiv('laser-toolbar-persist');

            const persistCheck = persistRow.createEl('input', {
                type: 'checkbox',
                attr: { id: 'laser-persist-toggle' }
            });
            persistCheck.checked = this.settings.persistTrails;

            persistRow.createEl('label', {
                text: 'Persist',
                attr: { for: 'laser-persist-toggle' }
            });

            persistCheck.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                this.settings.persistTrails = checked;
                void this.saveSettings();
            });
        }

        if (this.settings.showRememberToggle) {
            const rememberRow = this.toolbar.createDiv('laser-toolbar-remember');

            const rememberCheck = rememberRow.createEl('input', {
                type: 'checkbox',
                attr: { id: 'laser-remember-toggle' }
            });
            rememberCheck.checked = this.settings.rememberDrawings;

            rememberRow.createEl('label', {
                text: 'Remember',
                attr: { for: 'laser-remember-toggle' }
            });

            rememberCheck.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                this.settings.rememberDrawings = checked;
                void this.saveSettings();
                if (!checked) {
                    this.savedPaths = [];
                    void this.saveData({ ...this.settings, _savedPaths: [] });
                }
            });
        }
    }

    toggleEraserMode() {
        this.isEraserMode = !this.isEraserMode;

        if (this.isEraserMode) {
            if (this.svgContainer) {
                this.svgContainer.addClass('laser-svg-interactive');
            }
            if (this.laserPointer) {
                this.laserPointer.addClass('eraser-mode');
            }
            if (this.eraserBtn) {
                this.eraserBtn.addClass('active');
            }
            new Notice('🧽 Eraser mode ON — click a trail to delete it');
        } else {
            if (this.svgContainer) {
                this.svgContainer.removeClass('laser-svg-interactive');
            }
            if (this.laserPointer) {
                this.laserPointer.removeClass('eraser-mode');
            }
            if (this.eraserBtn) {
                this.eraserBtn.removeClass('active');
            }
            new Notice('✏️ Eraser mode OFF');
        }
    }

    onSvgClick(evt: MouseEvent) {
        if (!this.isEraserMode || !this.svgContainer) return;
        const target = evt.target as SVGPathElement;
        if (target && target.hasClass('laser-path')) {
            target.remove();
        }
    }

    clearAllPaths() {
        if (!this.svgContainer) return;
        while (this.svgContainer.firstChild) {
            this.svgContainer.removeChild(this.svgContainer.firstChild);
        }
        new Notice('🗑️ All trails cleared');
    }

    setLaserColor(color: string) {
        this.settings.laserColor = color;
        void this.saveSettings();
        this.applyLaserColor(color);
    }

    applyLaserColor(color: string) {
        if (this.laserPointer) {
            this.laserPointer.style.backgroundColor = color;
            this.laserPointer.style.boxShadow = `0 0 8px 3px ${color}, 0 0 16px 6px ${color}, 0 0 32px 10px ${color}`;
        }
    }

    onMouseDown(evt: MouseEvent) {
        const target = evt.target as HTMLElement;
        if (target.closest('.laser-toolbar')) return;

        if (this.isEraserMode) return;

        if (evt.button !== 0 || !this.isActive || !this.svgContainer) return;

        evt.preventDefault();

        this.isDrawing = true;
        this.points = [`${evt.clientX},${evt.clientY}`];

        this.currentPath = this.svgContainer.createSvg('path', { cls: 'laser-path' });
        const c = this.settings.laserColor;
        this.currentPath.style.stroke = c;
        this.currentPath.style.strokeWidth = `${this.settings.strokeWidth}px`;
        this.currentPath.style.strokeOpacity = String(this.settings.strokeHardness);
        this.currentPath.style.filter = `drop-shadow(0 0 3px ${c}) drop-shadow(0 0 6px ${c})`;
        this.currentPath.setAttribute('d', `M ${this.points[0]}`);
    }

    onMouseUp(evt: MouseEvent) {
        if (this.isDraggingToolbar) {
            this.isDraggingToolbar = false;
            if (this.laserPointer) {
                this.laserPointer.removeClass('laser-pointer-hidden');
            }
            return;
        }

        if (evt.button !== 0 || !this.isDrawing || !this.currentPath) return;
        this.isDrawing = false;

        if (this.settings.persistTrails) {
            this.currentPath = null;
            this.points = [];
            return;
        }

        const pathToFade = this.currentPath;
        const delay = this.settings.trailDuration * 1000;
        window.setTimeout(() => {
            pathToFade.addClass('fading');
            window.setTimeout(() => {
                if (pathToFade.parentNode) {
                    pathToFade.remove();
                }
            }, 1000);
        }, delay);

        this.currentPath = null;
        this.points = [];
    }

    handleContextMenu(evt: MouseEvent) {
        if (!this.isActive) return;
        evt.preventDefault();
        evt.stopPropagation();
        evt.stopImmediatePropagation();
        this.deactivateLaser();
        new Notice('⚫ Laser Pointer deactivated');
    }

    onunload() {
        this.deactivateLaser();
    }
}

class LaserPointerSettingTab extends PluginSettingTab {
    plugin: LaserPointerPlugin;

    constructor(app: App, plugin: LaserPointerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Laser color')
            .setDesc('Choose the color of the pointer and the drawn trails.')
            .addColorPicker(color => color
                .setValue(this.plugin.settings.laserColor)
                .onChange(async (value) => {
                    this.plugin.settings.laserColor = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Trail width (px)')
            .setDesc('Set the thickness of the drawn trails.')
            .addSlider(slider => slider
                .setLimits(0.5, 20, 0.5)
                .setValue(this.plugin.settings.strokeWidth)
                .onChange(async (value) => {
                    this.plugin.settings.strokeWidth = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Stroke hardness')
            .setDesc('How opaque the trail is. Low = faint and semi-transparent, High = solid and bold.')
            .addSlider(slider => slider
                .setLimits(0.1, 1, 0.1)
                .setValue(this.plugin.settings.strokeHardness)
                .onChange(async (value) => {
                    this.plugin.settings.strokeHardness = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Trail duration (seconds)')
            .setDesc('How many seconds the trail stays visible before fading away.')
            .addSlider(slider => slider
                .setLimits(1, 10, 0.5)
                .setValue(this.plugin.settings.trailDuration)
                .onChange(async (value) => {
                    this.plugin.settings.trailDuration = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Persist trails')
            .setDesc('When enabled, drawn trails remain visible until you exit laser mode instead of fading automatically.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.persistTrails)
                .onChange(async (value) => {
                    this.plugin.settings.persistTrails = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Remember drawings')
            .setDesc('When enabled, all drawn trails are saved when you exit laser mode and restored when you re-enter.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.rememberDrawings)
                .onChange(async (value) => {
                    this.plugin.settings.rememberDrawings = value;
                    await this.plugin.saveSettings();
                    if (!value) {
                        this.plugin.savedPaths = [];
                        await this.plugin.saveData({ ...this.plugin.settings, _savedPaths: [] });
                    }
                }));

        new Setting(containerEl)
            .setName('Auto reading mode')
            .setDesc('Automatically switch the active note to reading mode when the laser is activated, and restore the original mode when deactivated.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoReadingMode)
                .onChange(async (value) => {
                    this.plugin.settings.autoReadingMode = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Toolbar visibility')
            .setDesc('Choose which controls appear on the floating toolbar. Disabling items makes the toolbar smaller and more minimal.')
            .setHeading();

        const visibilityItems: { key: BooleanSettingKey; name: string }[] = [
            { key: 'showToolbarHeader', name: 'Header (drag handle)' },
            { key: 'showColorPresets', name: 'Color preset dots' },
            { key: 'showCustomColor', name: 'Custom color picker (🎨)' },
            { key: 'showWidthSlider', name: 'Width slider' },
            { key: 'showHardnessSlider', name: 'Hardness slider' },
            { key: 'showEraserButton', name: 'Eraser button (🧽)' },
            { key: 'showClearButton', name: 'Clear-all button (🗑️)' },
            { key: 'showPersistToggle', name: 'Persist trails toggle' },
            { key: 'showRememberToggle', name: 'Remember drawings toggle' },
        ];

        for (const item of visibilityItems) {
            new Setting(containerEl)
                .setName(item.name)
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings[item.key])
                    .onChange(async (value) => {
                        this.plugin.settings[item.key] = value;
                        await this.plugin.saveSettings();
                    }));
        }
    }
}
