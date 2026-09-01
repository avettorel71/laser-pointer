import { App, Plugin, Notice, PluginSettingTab, Setting, MarkdownView, WorkspaceLeaf, SettingDefinitionItem } from 'obsidian';

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
    showShapeToggle: boolean;
    showFillToggle: boolean;
    showLineToggle: boolean;
    rectangleFilled: boolean;
    presetColors: PresetColor[];
}

interface PresetColor {
    color: string;
    label: string;
}

interface SavedPath {
    d: string;
    stroke: string;
    strokeWidth: string;
    strokeOpacity: string;
    filter: string;
}

interface SavedRect {
    x: number;
    y: number;
    width: number;
    height: number;
    stroke: string;
    strokeWidth: string;
    strokeOpacity: string;
    filter: string;
    fill: string;
    fillOpacity: string;
}

interface SavedLine {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    stroke: string;
    strokeWidth: string;
    strokeOpacity: string;
    filter: string;
}

interface PersistedData extends Partial<LaserPointerSettings> {
    _savedPaths?: SavedPath[];
    _savedRects?: SavedRect[];
    _savedLines?: SavedLine[];
}

// Keys of LaserPointerSettings whose value type is boolean.
type BooleanSettingKey = {
    [K in keyof LaserPointerSettings]: LaserPointerSettings[K] extends boolean ? K : never;
}[keyof LaserPointerSettings];

// The original 11 colors, used both as the out-of-the-box preset list
// and as the target of "Reset to default colors" in Settings. Settings
// always work with copies of these objects (never this array directly)
// so a user editing their own presets can never mutate the defaults.
const DEFAULT_PRESET_COLORS: PresetColor[] = [
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

function cloneDefaultPresetColors(): PresetColor[] {
    return DEFAULT_PRESET_COLORS.map(preset => ({ ...preset }));
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
    showShapeToggle: true,
    showFillToggle: true,
    showLineToggle: true,
    rectangleFilled: false,
    presetColors: cloneDefaultPresetColors(),
};

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
    savedRects: SavedRect[] = [];
    savedLines: SavedLine[] = [];

    private toolbar: HTMLElement | null = null;
    private isDraggingToolbar: boolean = false;
    private dragOffsetX: number = 0;
    private dragOffsetY: number = 0;

    private isEraserMode: boolean = false;
    private eraserBtn: HTMLElement | null = null;

    // Drawing tool: 'freehand' draws trails (the original behavior),
    // 'rectangle' draws a draggable rectangle, 'line' draws a straight
    // segment. drawMode is kept in memory (not written to settings/disk)
    // but is intentionally NOT reset when the laser is deactivated, so
    // toggling the laser off and back on keeps whichever tool was active.
    // It only resets to 'freehand' on eraser mode entry, since eraser and
    // drawing tools are mutually exclusive. rectangleFilled (whether new
    // rectangles are filled or outline-only) IS persisted, since it is a
    // drawing default.
    private drawMode: 'freehand' | 'rectangle' | 'line' = 'freehand';
    private isDrawingRect: boolean = false;
    private currentRect: SVGRectElement | null = null;
    private rectStartX: number = 0;
    private rectStartY: number = 0;
    private shapeBtn: HTMLElement | null = null;
    private fillBtn: HTMLElement | null = null;

    private isDrawingLine: boolean = false;
    private currentLine: SVGLineElement | null = null;
    private lineStartX: number = 0;
    private lineStartY: number = 0;
    private lineBtn: HTMLElement | null = null;

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

            if (this.isDrawingRect && this.currentRect) {
                const x = Math.min(this.rectStartX, evt.clientX);
                const y = Math.min(this.rectStartY, evt.clientY);
                const width = Math.abs(evt.clientX - this.rectStartX);
                const height = Math.abs(evt.clientY - this.rectStartY);
                this.currentRect.setAttribute('x', String(x));
                this.currentRect.setAttribute('y', String(y));
                this.currentRect.setAttribute('width', String(width));
                this.currentRect.setAttribute('height', String(height));
            }

            if (this.isDrawingLine && this.currentLine) {
                this.currentLine.setAttribute('x2', String(evt.clientX));
                this.currentLine.setAttribute('y2', String(evt.clientY));
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
        // Always work with a fresh array/objects, never a shared reference
        // to DEFAULT_SETTINGS.presetColors or to the loaded data — editing
        // presets in Settings must never mutate either of those. Only fall
        // back to the defaults when the field is missing entirely (older
        // data.json); an empty array in saved data means the user
        // deliberately removed every preset, and that choice is kept.
        this.settings.presetColors = (data?.presetColors ?? DEFAULT_PRESET_COLORS)
            .map(preset => ({ ...preset }));
        this.savedPaths = data?._savedPaths ?? [];
        this.savedRects = data?._savedRects ?? [];
        this.savedLines = data?._savedLines ?? [];
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

        if (this.settings.rememberDrawings && this.savedRects.length > 0) {
            this.savedRects.forEach((saved) => {
                const rect = this.svgContainer!.createSvg('rect', { cls: 'laser-rect' });
                rect.setAttribute('x', String(saved.x));
                rect.setAttribute('y', String(saved.y));
                rect.setAttribute('width', String(saved.width));
                rect.setAttribute('height', String(saved.height));
                rect.style.stroke = saved.stroke;
                rect.style.strokeWidth = saved.strokeWidth;
                rect.style.strokeOpacity = saved.strokeOpacity;
                rect.style.filter = saved.filter;
                rect.style.fill = saved.fill;
                rect.style.fillOpacity = saved.fillOpacity;
            });
        }

        if (this.settings.rememberDrawings && this.savedLines.length > 0) {
            this.savedLines.forEach((saved) => {
                const line = this.svgContainer!.createSvg('line', { cls: 'laser-line' });
                line.setAttribute('x1', String(saved.x1));
                line.setAttribute('y1', String(saved.y1));
                line.setAttribute('x2', String(saved.x2));
                line.setAttribute('y2', String(saved.y2));
                line.style.stroke = saved.stroke;
                line.style.strokeWidth = saved.strokeWidth;
                line.style.strokeOpacity = saved.strokeOpacity;
                line.style.filter = saved.filter;
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
            this.savedRects = [];
            this.savedLines = [];
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
            this.svgContainer.querySelectorAll('.laser-rect').forEach((rectEl) => {
                const r = rectEl as SVGRectElement;
                this.savedRects.push({
                    x: parseFloat(r.getAttribute('x') || '0'),
                    y: parseFloat(r.getAttribute('y') || '0'),
                    width: parseFloat(r.getAttribute('width') || '0'),
                    height: parseFloat(r.getAttribute('height') || '0'),
                    stroke: r.style.stroke,
                    strokeWidth: r.style.strokeWidth,
                    strokeOpacity: r.style.strokeOpacity || '1',
                    filter: r.style.filter,
                    fill: r.style.fill || 'transparent',
                    fillOpacity: r.style.fillOpacity || '1',
                });
            });
            this.svgContainer.querySelectorAll('.laser-line').forEach((lineEl) => {
                const l = lineEl as SVGLineElement;
                this.savedLines.push({
                    x1: parseFloat(l.getAttribute('x1') || '0'),
                    y1: parseFloat(l.getAttribute('y1') || '0'),
                    x2: parseFloat(l.getAttribute('x2') || '0'),
                    y2: parseFloat(l.getAttribute('y2') || '0'),
                    stroke: l.style.stroke,
                    strokeWidth: l.style.strokeWidth,
                    strokeOpacity: l.style.strokeOpacity || '1',
                    filter: l.style.filter,
                });
            });
            void this.saveData({ ...this.settings, _savedPaths: this.savedPaths, _savedRects: this.savedRects, _savedLines: this.savedLines });
        } else {
            this.savedPaths = [];
            this.savedRects = [];
            this.savedLines = [];
            void this.saveData({ ...this.settings, _savedPaths: [], _savedRects: [], _savedLines: [] });
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
        this.shapeBtn = null;
        this.fillBtn = null;
        this.lineBtn = null;
        this.isDrawing = false;
        this.isDrawingRect = false;
        this.isDrawingLine = false;
        this.isDraggingToolbar = false;
        this.currentPath = null;
        this.currentRect = null;
        this.currentLine = null;
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
                this.settings.presetColors.forEach(preset => {
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

        if (this.settings.showShapeToggle) {
            // Rectangle tool and the fill/outline toggle share a single row
            // so the fill toggle sits right next to the rectangle button —
            // it's a modifier of the rectangle tool, not an independent
            // control, and it only makes sense while that tool is active.
            const shapeRow = this.toolbar.createDiv('laser-toolbar-shape');

            this.shapeBtn = shapeRow.createEl('button', {
                cls: 'laser-action-btn',
                attr: { 'aria-label': 'Rectangle tool' },
                text: '▭'
            });
            if (this.drawMode === 'rectangle') {
                this.shapeBtn.addClass('active');
            }
            this.shapeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.setDrawMode(this.drawMode === 'rectangle' ? 'freehand' : 'rectangle');
            });

            if (this.settings.showFillToggle) {
                this.fillBtn = shapeRow.createEl('button', {
                    cls: 'laser-action-btn',
                    attr: { 'aria-label': 'Toggle filled / outline rectangles' },
                    text: this.settings.rectangleFilled ? '🔳' : '⬜'
                });
                if (this.settings.rectangleFilled) {
                    this.fillBtn.addClass('active');
                }
                // Only visible while the rectangle tool is the active
                // drawing mode; setDrawMode()/toggleEraserMode() flip this.
                if (this.drawMode !== 'rectangle') {
                    this.fillBtn.addClass('laser-hidden');
                }
                this.fillBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleRectangleFilled();
                });
            }
        }

        if (this.settings.showLineToggle) {
            const lineRow = this.toolbar.createDiv('laser-toolbar-line');

            this.lineBtn = lineRow.createEl('button', {
                cls: 'laser-action-btn',
                attr: { 'aria-label': 'Straight line tool' },
                text: '╱'
            });
            if (this.drawMode === 'line') {
                this.lineBtn.addClass('active');
            }
            this.lineBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.setDrawMode(this.drawMode === 'line' ? 'freehand' : 'line');
            });
        }

        if (this.settings.showWidthSlider) {
            const widthRow = this.toolbar.createDiv('laser-toolbar-width');

            const widthLabel = widthRow.createEl('label', { text: `Width: ${this.settings.strokeWidth}px` });

            const slider = widthRow.createEl('input', {
                type: 'range',
                cls: 'laser-width-slider',
                attr: { min: '0.5', max: '40', step: '0.5' }
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
                attr: { min: '0.05', max: '1', step: '0.05' }
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
                    this.savedRects = [];
                    this.savedLines = [];
                    void this.saveData({ ...this.settings, _savedPaths: [], _savedRects: [], _savedLines: [] });
                }
            });
        }
    }

    toggleEraserMode() {
        this.isEraserMode = !this.isEraserMode;

        if (this.isEraserMode) {
            if (this.drawMode !== 'freehand') {
                this.drawMode = 'freehand';
                if (this.shapeBtn) {
                    this.shapeBtn.removeClass('active');
                }
                if (this.lineBtn) {
                    this.lineBtn.removeClass('active');
                }
                if (this.fillBtn) {
                    this.fillBtn.addClass('laser-hidden');
                }
            }
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

    /**
     * Switches the active drawing tool. Only one of freehand / rectangle /
     * line can be active at a time, so this also updates both toolbar
     * buttons' active state and turns eraser mode off if it was on.
     */
    setDrawMode(mode: 'freehand' | 'rectangle' | 'line') {
        this.drawMode = mode;

        if (this.drawMode !== 'freehand' && this.isEraserMode) {
            this.toggleEraserMode();
        }

        if (this.shapeBtn) {
            this.shapeBtn.toggleClass('active', this.drawMode === 'rectangle');
        }
        if (this.lineBtn) {
            this.lineBtn.toggleClass('active', this.drawMode === 'line');
        }
        if (this.fillBtn) {
            this.fillBtn.toggleClass('laser-hidden', this.drawMode !== 'rectangle');
        }

        const label = this.drawMode === 'rectangle'
            ? '▭ Rectangle tool ON'
            : this.drawMode === 'line'
                ? '╱ Line tool ON'
                : '✏️ Freehand tool ON';
        new Notice(label);
    }

    toggleRectangleFilled() {
        this.settings.rectangleFilled = !this.settings.rectangleFilled;
        void this.saveSettings();

        if (this.fillBtn) {
            this.fillBtn.toggleClass('active', this.settings.rectangleFilled);
            this.fillBtn.setText(this.settings.rectangleFilled ? '🔳' : '⬜');
        }
        new Notice(this.settings.rectangleFilled ? '🔳 Filled rectangles' : '⬜ Outline rectangles');
    }

    onSvgClick(evt: MouseEvent) {
        if (!this.isEraserMode || !this.svgContainer) return;
        const target = evt.target as SVGElement;
        if (target && (target.hasClass('laser-path') || target.hasClass('laser-rect') || target.hasClass('laser-line'))) {
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

        if (this.drawMode === 'rectangle') {
            this.isDrawingRect = true;
            this.rectStartX = evt.clientX;
            this.rectStartY = evt.clientY;

            this.currentRect = this.svgContainer.createSvg('rect', { cls: 'laser-rect' });
            const rc = this.settings.laserColor;
            this.currentRect.style.stroke = rc;
            this.currentRect.style.strokeWidth = `${this.settings.strokeWidth}px`;
            this.currentRect.style.strokeOpacity = String(this.settings.strokeHardness);
            this.currentRect.style.filter = `drop-shadow(0 0 3px ${rc}) drop-shadow(0 0 6px ${rc})`;
            // "transparent" (rather than "none") keeps the rectangle's
            // interior clickable in eraser mode even when outline-only.
            this.currentRect.style.fill = this.settings.rectangleFilled ? rc : 'transparent';
            this.currentRect.style.fillOpacity = this.settings.rectangleFilled ? String(this.settings.strokeHardness) : '1';
            this.currentRect.setAttribute('x', String(evt.clientX));
            this.currentRect.setAttribute('y', String(evt.clientY));
            this.currentRect.setAttribute('width', '0');
            this.currentRect.setAttribute('height', '0');
            return;
        }

        if (this.drawMode === 'line') {
            this.isDrawingLine = true;
            this.lineStartX = evt.clientX;
            this.lineStartY = evt.clientY;

            this.currentLine = this.svgContainer.createSvg('line', { cls: 'laser-line' });
            const lc = this.settings.laserColor;
            this.currentLine.style.stroke = lc;
            this.currentLine.style.strokeWidth = `${this.settings.strokeWidth}px`;
            this.currentLine.style.strokeOpacity = String(this.settings.strokeHardness);
            this.currentLine.style.filter = `drop-shadow(0 0 3px ${lc}) drop-shadow(0 0 6px ${lc})`;
            this.currentLine.setAttribute('x1', String(evt.clientX));
            this.currentLine.setAttribute('y1', String(evt.clientY));
            this.currentLine.setAttribute('x2', String(evt.clientX));
            this.currentLine.setAttribute('y2', String(evt.clientY));
            return;
        }

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

        if (evt.button !== 0) return;

        if (this.isDrawingRect && this.currentRect) {
            this.isDrawingRect = false;

            const rect = this.currentRect;
            this.currentRect = null;

            const width = parseFloat(rect.getAttribute('width') || '0');
            const height = parseFloat(rect.getAttribute('height') || '0');

            // Discard accidental clicks/drags too small to be an intentional rectangle
            if (width < 2 && height < 2) {
                rect.remove();
                return;
            }

            if (this.settings.persistTrails) {
                return;
            }

            const rectToFade = rect;
            const delay = this.settings.trailDuration * 1000;
            window.setTimeout(() => {
                rectToFade.addClass('fading');
                window.setTimeout(() => {
                    if (rectToFade.parentNode) {
                        rectToFade.remove();
                    }
                }, 1000);
            }, delay);
            return;
        }

        if (this.isDrawingLine && this.currentLine) {
            this.isDrawingLine = false;

            const line = this.currentLine;
            this.currentLine = null;

            const x1 = parseFloat(line.getAttribute('x1') || '0');
            const y1 = parseFloat(line.getAttribute('y1') || '0');
            const x2 = parseFloat(line.getAttribute('x2') || '0');
            const y2 = parseFloat(line.getAttribute('y2') || '0');
            const length = Math.hypot(x2 - x1, y2 - y1);

            // Discard accidental clicks too short to be an intentional line
            if (length < 2) {
                line.remove();
                return;
            }

            if (this.settings.persistTrails) {
                return;
            }

            const lineToFade = line;
            const lineDelay = this.settings.trailDuration * 1000;
            window.setTimeout(() => {
                lineToFade.addClass('fading');
                window.setTimeout(() => {
                    if (lineToFade.parentNode) {
                        lineToFade.remove();
                    }
                }, 1000);
            }, lineDelay);
            return;
        }

        if (!this.isDrawing || !this.currentPath) return;
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

    /**
     * Declarative settings (Obsidian 1.13.0+, the plugin's minAppVersion).
     * No display() fallback: this plugin only ever runs on Obsidian
     * versions that render from getSettingDefinitions() directly.
     *
     * Preset colors use a 'list' definition (SettingDefinitionList): it's
     * built specifically for add/remove/reorder collections and renders
     * its own delete button and "+" add affordance, so the per-row
     * render() callback only needs to draw the color picker and label —
     * see applyPresetColorFields() below.
     */
    getSettingDefinitions(): SettingDefinitionItem[] {
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
            { key: 'showShapeToggle', name: 'Rectangle tool button (▭)' },
            { key: 'showFillToggle', name: 'Fill/outline toggle (⬜/🔳) — next to the rectangle button, shown only while it is active' },
            { key: 'showLineToggle', name: 'Straight line tool button (╱)' },
        ];

        return [
            {
                name: 'Laser color',
                desc: 'Choose the color of the pointer and the drawn trails.',
                control: { type: 'color', key: 'laserColor', defaultValue: DEFAULT_SETTINGS.laserColor },
            },
            {
                name: 'Trail width (px)',
                desc: 'Set the thickness of the drawn trails.',
                control: { type: 'slider', key: 'strokeWidth', min: 0.5, max: 40, step: 0.5, defaultValue: DEFAULT_SETTINGS.strokeWidth },
            },
            {
                name: 'Stroke hardness',
                desc: 'How opaque the trail is. Low = faint and semi-transparent, High = solid and bold.',
                control: { type: 'slider', key: 'strokeHardness', min: 0.05, max: 1, step: 0.05, defaultValue: DEFAULT_SETTINGS.strokeHardness },
            },
            {
                name: 'Trail duration (seconds)',
                desc: 'How many seconds the trail stays visible before fading away.',
                control: { type: 'slider', key: 'trailDuration', min: 1, max: 10, step: 0.5, defaultValue: DEFAULT_SETTINGS.trailDuration },
            },
            {
                name: 'Persist trails',
                desc: 'When enabled, drawn trails remain visible until you exit laser mode instead of fading automatically.',
                control: { type: 'toggle', key: 'persistTrails', defaultValue: DEFAULT_SETTINGS.persistTrails },
            },
            {
                name: 'Remember drawings',
                desc: 'When enabled, all drawn trails are saved when you exit laser mode and restored when you re-enter.',
                control: { type: 'toggle', key: 'rememberDrawings', defaultValue: DEFAULT_SETTINGS.rememberDrawings },
            },
            {
                name: 'Auto reading mode',
                desc: 'Automatically switch the active note to reading mode when the laser is activated, and restore the original mode when deactivated.',
                control: { type: 'toggle', key: 'autoReadingMode', defaultValue: DEFAULT_SETTINGS.autoReadingMode },
            },
            {
                name: 'Rectangles filled by default',
                desc: 'When enabled, the rectangle tool draws solid filled rectangles. When disabled, it draws outline-only rectangles. This can also be toggled from the toolbar at any time.',
                control: { type: 'toggle', key: 'rectangleFilled', defaultValue: DEFAULT_SETTINGS.rectangleFilled },
            },
            {
                type: 'list',
                heading: 'Preset colors',
                items: this.plugin.settings.presetColors.map((preset, index) => ({
                    name: preset.label || `Color ${index + 1}`,
                    render: (setting: Setting) => {
                        this.applyPresetColorFields(setting, preset);
                    },
                })),
                onDelete: (index) => {
                    this.plugin.settings.presetColors.splice(index, 1);
                    void this.plugin.saveSettings();
                    this.refresh();
                },
                addItem: {
                    name: 'Add color',
                    action: () => {
                        this.plugin.settings.presetColors.push({ color: '#ffffff', label: 'New color' });
                        void this.plugin.saveSettings();
                        this.refresh();
                    },
                },
                extraButtons: [
                    btn => btn
                        .setIcon('rotate-ccw')
                        .setTooltip('Reset to default colors')
                        .onClick(() => {
                            this.plugin.settings.presetColors = cloneDefaultPresetColors();
                            void this.plugin.saveSettings();
                            this.refresh();
                        }),
                ],
            },
            {
                type: 'group',
                heading: 'Toolbar visibility',
                items: visibilityItems.map(item => ({
                    name: item.name,
                    control: { type: 'toggle' as const, key: item.key, defaultValue: DEFAULT_SETTINGS[item.key] },
                })),
            },
        ];
    }

    getControlValue(key: string): unknown {
        return this.plugin.settings[key as keyof LaserPointerSettings];
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        const settingKey = key as keyof LaserPointerSettings;
        this.assignSetting(settingKey, value);
        await this.plugin.saveSettings();
        if (settingKey === 'rememberDrawings' && value === false) {
            this.plugin.savedPaths = [];
            this.plugin.savedRects = [];
            this.plugin.savedLines = [];
            await this.plugin.saveData({ ...this.plugin.settings, _savedPaths: [], _savedRects: [], _savedLines: [] });
        }
    }

    private assignSetting<K extends keyof LaserPointerSettings>(key: K, value: unknown): void {
        this.plugin.settings[key] = value as LaserPointerSettings[K];
    }

    /**
     * Refreshes the settings tab after a change that adds/removes a row
     * (the preset color list) rather than just editing a value in place.
     * Always safe to call unconditionally: minAppVersion is 1.13.0, so
     * update() is guaranteed to exist.
     */
    private refresh(): void {
        this.update();
    }

    /**
     * Color picker + label text field for one preset color, used by the
     * declarative 'list' definition above — the list itself supplies the
     * delete button and "+" add affordance, so this only needs to draw
     * the two editable fields.
     */
    private applyPresetColorFields(setting: Setting, preset: PresetColor): void {
        setting
            .addColorPicker(picker => picker
                .setValue(preset.color)
                .onChange(async (value) => {
                    preset.color = value;
                    await this.plugin.saveSettings();
                }))
            .addText(text => text
                .setPlaceholder('Label')
                .setValue(preset.label)
                .onChange(async (value) => {
                    preset.label = value;
                    await this.plugin.saveSettings();
                }));
    }

}
