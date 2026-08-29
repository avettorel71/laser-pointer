import { Plugin, Notice, PluginSettingTab, Setting, MarkdownView, WorkspaceLeaf } from 'obsidian';

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
            id: 'toggle-laser-pointer',
            name: 'Toggle Laser Pointer',
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
        const data = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
        this.savedPaths = (data && data._savedPaths) ? data._savedPaths : [];
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
                    leaf.setViewState({
                        type: 'markdown',
                        state: { ...state.state, mode: 'preview' }
                    });
                }
            }
        }

        this.laserPointer = document.createElement('div');
        this.laserPointer.addClass('laser-pointer');
        this.applyLaserColor(this.settings.laserColor);
        this.laserPointer.style.left = `${this.lastMouseX}px`;
        this.laserPointer.style.top = `${this.lastMouseY}px`;
        document.body.appendChild(this.laserPointer);

        this.svgContainer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.svgContainer.addClass('laser-svg-container');
        document.body.appendChild(this.svgContainer);

        this.svgContainer.addEventListener('click', this.boundOnSvgClick);

        if (this.settings.rememberDrawings && this.savedPaths.length > 0) {
            this.savedPaths.forEach((saved) => {
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.addClass('laser-path');
                path.setAttribute('d', saved.d);
                path.style.stroke = saved.stroke;
                path.style.strokeWidth = saved.strokeWidth;
                path.style.strokeOpacity = saved.strokeOpacity;
                path.style.filter = saved.filter;
                this.svgContainer!.appendChild(path);
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
                this.targetLeaf.setViewState({
                    type: 'markdown',
                    state: { ...state.state, mode: this.originalMode }
                });
            } catch (e) {
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
            this.saveData({ ...this.settings, _savedPaths: this.savedPaths });
        } else {
            this.savedPaths = [];
            this.saveData({ ...this.settings, _savedPaths: [] });
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
        this.toolbar = document.createElement('div');
        this.toolbar.addClass('laser-toolbar');

        if (this.settings.showToolbarHeader) {
            const header = document.createElement('div');
            header.addClass('laser-toolbar-header');
            header.setText('Laser Pointer');
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
            this.toolbar.appendChild(header);
        }

        if (this.settings.showColorPresets || this.settings.showCustomColor) {
            const colorRow = document.createElement('div');
            colorRow.addClass('laser-toolbar-colors');

            if (this.settings.showColorPresets) {
                PRESET_COLORS.forEach(preset => {
                    const btn = document.createElement('button');
                    btn.addClass('laser-color-btn');
                    btn.setAttribute('data-color', preset.color);
                    btn.setAttribute('aria-label', preset.label);
                    btn.style.backgroundColor = preset.color;
                    if (this.settings.laserColor === preset.color) btn.addClass('active');

                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.setLaserColor(preset.color);
                        colorRow.querySelectorAll('.laser-color-btn').forEach(b => b.removeClass('active'));
                        btn.addClass('active');
                    });
                    colorRow.appendChild(btn);
                });
            }

            if (this.settings.showCustomColor) {
                const customBtn = document.createElement('button');
                customBtn.addClass('laser-color-btn');
                customBtn.addClass('laser-color-custom');
                customBtn.setAttribute('aria-label', 'Custom color');
                customBtn.setText('🎨');

                const colorInput = document.createElement('input');
                colorInput.type = 'color';
                colorInput.addClass('laser-color-picker-hidden');
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

                colorRow.appendChild(customBtn);
                colorRow.appendChild(colorInput);
            }

            this.toolbar.appendChild(colorRow);
        }

        if (this.settings.showWidthSlider) {
            const widthRow = document.createElement('div');
            widthRow.addClass('laser-toolbar-width');

            const widthLabel = document.createElement('label');
            widthLabel.setText(`Width: ${this.settings.strokeWidth}px`);
            widthRow.appendChild(widthLabel);

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.addClass('laser-width-slider');
            slider.min = '0.5';
            slider.max = '20';
            slider.step = '0.5';
            slider.value = String(this.settings.strokeWidth);

            slider.addEventListener('input', (e) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                this.settings.strokeWidth = val;
                this.saveSettings();
                widthLabel.setText(`Width: ${val}px`);
            });

            widthRow.appendChild(slider);
            this.toolbar.appendChild(widthRow);
        }

        if (this.settings.showHardnessSlider) {
            const hardnessRow = document.createElement('div');
            hardnessRow.addClass('laser-toolbar-hardness');

            const hardnessLabel = document.createElement('label');
            hardnessLabel.setText(`Hard: ${Math.round(this.settings.strokeHardness * 100)}%`);
            hardnessRow.appendChild(hardnessLabel);

            const hardnessSlider = document.createElement('input');
            hardnessSlider.type = 'range';
            hardnessSlider.addClass('laser-width-slider');
            hardnessSlider.min = '0.1';
            hardnessSlider.max = '1';
            hardnessSlider.step = '0.1';
            hardnessSlider.value = String(this.settings.strokeHardness);

            hardnessSlider.addEventListener('input', (e) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                this.settings.strokeHardness = val;
                this.saveSettings();
                hardnessLabel.setText(`Hard: ${Math.round(val * 100)}%`);
            });

            hardnessRow.appendChild(hardnessSlider);
            this.toolbar.appendChild(hardnessRow);
        }

        if (this.settings.showEraserButton || this.settings.showClearButton) {
            const actionsRow = document.createElement('div');
            actionsRow.addClass('laser-toolbar-actions');

            if (this.settings.showEraserButton) {
                this.eraserBtn = document.createElement('button');
                this.eraserBtn.addClass('laser-action-btn');
                this.eraserBtn.setAttribute('aria-label', 'Eraser');
                this.eraserBtn.setText('🧽');
                this.eraserBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleEraserMode();
                });
                actionsRow.appendChild(this.eraserBtn);
            }

            if (this.settings.showClearButton) {
                const clearBtn = document.createElement('button');
                clearBtn.addClass('laser-action-btn');
                clearBtn.setAttribute('aria-label', 'Clear all trails');
                clearBtn.setText('🗑️');
                clearBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.clearAllPaths();
                });
                actionsRow.appendChild(clearBtn);
            }

            this.toolbar.appendChild(actionsRow);
        }

        if (this.settings.showPersistToggle) {
            const persistRow = document.createElement('div');
            persistRow.addClass('laser-toolbar-persist');

            const persistCheck = document.createElement('input');
            persistCheck.type = 'checkbox';
            persistCheck.id = 'laser-persist-toggle';
            persistCheck.checked = this.settings.persistTrails;

            const persistLabel = document.createElement('label');
            persistLabel.setAttribute('for', 'laser-persist-toggle');
            persistLabel.setText('Persist');

            persistCheck.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                this.settings.persistTrails = checked;
                this.saveSettings();
            });

            persistRow.appendChild(persistCheck);
            persistRow.appendChild(persistLabel);
            this.toolbar.appendChild(persistRow);
        }

        if (this.settings.showRememberToggle) {
            const rememberRow = document.createElement('div');
            rememberRow.addClass('laser-toolbar-remember');

            const rememberCheck = document.createElement('input');
            rememberCheck.type = 'checkbox';
            rememberCheck.id = 'laser-remember-toggle';
            rememberCheck.checked = this.settings.rememberDrawings;

            const rememberLabel = document.createElement('label');
            rememberLabel.setAttribute('for', 'laser-remember-toggle');
            rememberLabel.setText('Remember');

            rememberCheck.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                this.settings.rememberDrawings = checked;
                this.saveSettings();
                if (!checked) {
                    this.savedPaths = [];
                    this.saveData({ ...this.settings, _savedPaths: [] });
                }
            });

            rememberRow.appendChild(rememberCheck);
            rememberRow.appendChild(rememberLabel);
            this.toolbar.appendChild(rememberRow);
        }

        document.body.appendChild(this.toolbar);
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
        this.saveSettings();
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

        this.currentPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        this.currentPath.addClass('laser-path');
        const c = this.settings.laserColor;
        this.currentPath.style.stroke = c;
        this.currentPath.style.strokeWidth = `${this.settings.strokeWidth}px`;
        this.currentPath.style.strokeOpacity = String(this.settings.strokeHardness);
        this.currentPath.style.filter = `drop-shadow(0 0 3px ${c}) drop-shadow(0 0 6px ${c})`;
        this.currentPath.setAttribute('d', `M ${this.points[0]}`);
        this.svgContainer.appendChild(this.currentPath);
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
        setTimeout(() => {
            pathToFade.addClass('fading');
            setTimeout(() => {
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

    constructor(app: any, plugin: LaserPointerPlugin) {
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
                .setDynamicTooltip()
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
                .setDynamicTooltip()
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
                .setDynamicTooltip()
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

        const visibilityItems: { key: keyof LaserPointerSettings; name: string }[] = [
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
                    .setValue(this.plugin.settings[item.key] as boolean)
                    .onChange(async (value) => {
                        (this.plugin.settings as any)[item.key] = value;
                        await this.plugin.saveSettings();
                    }));
        }
    }
}
