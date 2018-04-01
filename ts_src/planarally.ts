import socket from './socket'
import { l2g } from "./units";
import { LayerManager, Layer, GridLayer, FOWLayer } from "./layers";
import { ClientOptions, BoardInfo, ServerShape, InitiativeData } from './api_types';
import { OrderedMap } from './utils';
import Asset from './shapes/asset';
import {createShapeFromDict} from './shapes/utils';
import { DrawTool, RulerTool, MapTool, FOWTool, InitiativeTracker, Tool } from "./tools";
import { LocalPoint } from './geom';

class GameManager {
    IS_DM = false;
    username: string = "";
    board_initialised = false;
    layerManager = new LayerManager();
    selectedTool: number = 0;
    tools: OrderedMap<string, Tool> = new OrderedMap();
    lightsources: { shape: string, aura: string }[] = [];
    lightblockers: string[] = [];
    movementblockers: string[] = [];
    gridColour = $("#gridColour");
    fowColour = $("#fowColour");
    initiativeTracker = new InitiativeTracker();
    shapeSelectionDialog = $("#shapeselectiondialog").dialog({
        autoOpen: false,
        width: 'auto'
    });
    initiativeDialog = $("#initiativedialog").dialog({
        autoOpen: false,
        width: '160px'
    });

    constructor() {
        this.gridColour.spectrum({
            showInput: true,
            allowEmpty: true,
            showAlpha: true,
            color: "rgba(255,0,0, 0.5)",
            move: function () {
                gameManager.layerManager.drawGrid()
            },
            change: function (colour) {
                socket.emit("set clientOptions", { 'gridColour': colour.toRgbString() });
            }
        });
        this.fowColour.spectrum({
            showInput: true,
            color: "rgb(82, 81, 81)",
            move: function (colour) {
                const l = gameManager.layerManager.getLayer("fow");
                if (l !== undefined) {
                    l.shapes.forEach(function (shape) {
                        shape.fill = colour.toRgbString();
                    });
                    l.invalidate(false);
                }
            },
            change: function (colour) {
                socket.emit("set clientOptions", { 'fowColour': colour.toRgbString() });
            }
        });
    }

    setupBoard(room: BoardInfo): void {
        this.layerManager = new LayerManager();
        const layersdiv = $('#layers');
        layersdiv.empty();
        const layerselectdiv = $('#layerselect');
        layerselectdiv.find("ul").empty();
        let selectable_layers = 0;

        const lm = $("#locations-menu").find("div");
        lm.children().off();
        lm.empty();
        for (let i = 0; i < room.locations.length; i++) {
            const loc = $("<div>" + room.locations[i] + "</div>");
            lm.append(loc);
        }
        const lmplus = $('<div><i class="fas fa-plus"></i></div>');
        lm.append(lmplus);
        lm.children().on("click", function (e) {
            if (e.target.textContent === '') {
                const locname = prompt("New location name");
                if (locname !== null)
                    socket.emit("new location", locname);
            } else {
                socket.emit("change location", e.target.textContent);
            }
        });

        for (let i = 0; i < room.board.layers.length; i++) {
            const new_layer = room.board.layers[i];
            // UI changes
            layersdiv.append("<canvas id='" + new_layer.name + "-layer' style='z-index: " + i + "'></canvas>");
            if (new_layer.selectable) {
                let extra = '';
                if (selectable_layers === 0) extra = " class='layer-selected'";
                layerselectdiv.find('ul').append("<li id='select-" + new_layer.name + "'" + extra + "><a href='#'>" + new_layer.name + "</a></li>");
                selectable_layers += 1;
            }
            const canvas = <HTMLCanvasElement>$('#' + new_layer.name + '-layer')[0];
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            // State changes
            let l: Layer;
            if (new_layer.grid)
                l = new GridLayer(canvas, new_layer.name);
            else if (new_layer.name === 'fow')
                l = new FOWLayer(canvas, new_layer.name);
            else
                l = new Layer(canvas, new_layer.name);
            l.selectable = new_layer.selectable;
            l.player_editable = new_layer.player_editable;
            gameManager.layerManager.addLayer(l);
            if (new_layer.grid) {
                gameManager.layerManager.setGridSize(new_layer.size);
                gameManager.layerManager.drawGrid();
                $("#grid-layer").droppable({
                    accept: ".draggable",
                    drop: function (event, ui) {
                        if (gameManager.layerManager.getLayer() === undefined) {
                            console.log("No active layer to drop the token on");
                            return;
                        }
                        const l = gameManager.layerManager.getLayer()!;
                        const jCanvas = $(l.canvas);
                        if (jCanvas.length === 0){
                            console.log("Canvas missing");
                            return;
                        }
                        const offset = jCanvas.offset()!;

                        const loc = new LocalPoint(ui.offset.left - offset.left, ui.offset.top - offset.top);

                        if (settings_menu.is(":visible") && loc.x < settings_menu.width()!)
                            return;
                        if (locations_menu.is(":visible") && loc.y < locations_menu.width()!)
                            return;
                        // width = ui.helper[0].width;
                        // height = ui.helper[0].height;
                        const wloc = l2g(loc);
                        const img = <HTMLImageElement>ui.draggable[0].children[0];
                        const asset = new Asset(img, wloc.x, wloc.y, img.width, img.height);
                        asset.src = img.src;

                        if (gameManager.layerManager.useGrid) {
                            const gs = gameManager.layerManager.gridSize;
                            asset.refPoint.x = Math.round(asset.refPoint.x / gs) * gs;
                            asset.refPoint.y = Math.round(asset.refPoint.y / gs) * gs;
                            asset.w = Math.max(Math.round(asset.w / gs) * gs, gs);
                            asset.h = Math.max(Math.round(asset.h / gs) * gs, gs);
                        }

                        l.addShape(asset, true);
                    }
                });
            } else {
                l.setShapes(new_layer.shapes);
            }
        }
        // Force the correct opacity render on other layers.
        gameManager.layerManager.setLayer(gameManager.layerManager.getLayer()!.name);
        // socket.emit("client initialised");
        this.board_initialised = true;

        if (selectable_layers > 1) {
            layerselectdiv.find("li").on("click", function () {
                const name = this.id.split("-")[1];
                const old = layerselectdiv.find("#select-" + gameManager.layerManager.selectedLayer);
                if (name !== gameManager.layerManager.selectedLayer) {
                    $(this).addClass("layer-selected");
                    old.removeClass("layer-selected");
                    gameManager.layerManager.setLayer(name);
                }
            });
        } else {
            layerselectdiv.hide();
        }
    }

    addShape(shape: ServerShape): void {
        if (!gameManager.layerManager.hasLayer(shape.layer)) {
            console.log(`Shape with unknown layer ${shape.layer} could not be added`);
            return;
        }
        const layer = this.layerManager.getLayer(shape.layer)!;
        layer.addShape(createShapeFromDict(shape), false);
        layer.invalidate(false);
    }

    moveShape(shape: ServerShape): void {
        if (!gameManager.layerManager.hasLayer(shape.layer)) {
            console.log(`Shape with unknown layer ${shape.layer} could not be added`);
            return;
        }
        const real_shape = Object.assign(this.layerManager.UUIDMap.get(shape.uuid), createShapeFromDict(shape, true));
        real_shape.checkLightSources();
        this.layerManager.getLayer(real_shape.layer)!.onShapeMove(real_shape);
    }

    updateShape(data: {shape: ServerShape; redraw: boolean;}): void {
        if (!gameManager.layerManager.hasLayer(data.shape.layer)){
            console.log(`Shape with unknown layer ${data.shape.layer} could not be added`);
            return;
        }
        const shape = Object.assign(this.layerManager.UUIDMap.get(data.shape.uuid), createShapeFromDict(data.shape, true));
        shape.checkLightSources();
        shape.setMovementBlock(shape.movementObstruction);
        if (data.redraw)
            this.layerManager.getLayer(data.shape.layer)!.invalidate(false);
    }

    setInitiative(data: InitiativeData[]): void {
        this.initiativeTracker.data = data;
        this.initiativeTracker.redraw();
        if (data.length > 0)
            this.initiativeDialog.dialog("open");
    }

    setClientOptions(options: ClientOptions): void {
        if ("gridColour" in options)
            this.gridColour.spectrum("set", options.gridColour);
        if ("fowColour" in options) {
            this.fowColour.spectrum("set", options.fowColour);
            this.layerManager.invalidate();
        }
        if ("panX" in options)
            this.layerManager.panX = options.panX;
        if ("panY" in options)
            this.layerManager.panY = options.panY;
        if ("zoomFactor" in options) {
            this.layerManager.zoomFactor = options.zoomFactor;
            $("#zoomer").slider({ value: 1 / options.zoomFactor });
            if (this.layerManager.getGridLayer() !== undefined)
                this.layerManager.getGridLayer()!.invalidate(false);
        }
    }
}


let gameManager = new GameManager();
(<any>window).gameManager = gameManager;

// **** SETUP UI ****

// prevent double clicking text selection
window.addEventListener('selectstart', function (e) {
    e.preventDefault();
    return false;
});

function onPointerDown(e: MouseEvent) {
    if (!gameManager.board_initialised) return;
    if ((e.button !== 0 && e.button !== 1) || (<HTMLElement>e.target).tagName !== 'CANVAS') return;
    $menu.hide();
    gameManager.tools.getIndexValue(gameManager.selectedTool)!.onMouseDown(e);
}

function onPointerMove(e: MouseEvent) {
    if (!gameManager.board_initialised) return;
    if ((e.button !== 0 && e.button !== 1) || (<HTMLElement>e.target).tagName !== 'CANVAS') return;
    gameManager.tools.getIndexValue(gameManager.selectedTool)!.onMouseMove(e);
}

function onPointerUp(e: MouseEvent) {
    if (!gameManager.board_initialised) return;
    if ((e.button !== 0 && e.button !== 1) || (<HTMLElement>e.target).tagName !== 'CANVAS') return;
    gameManager.tools.getIndexValue(gameManager.selectedTool)!.onMouseUp(e);
}

window.addEventListener("mousedown", onPointerDown);
window.addEventListener("mousemove", onPointerMove);
window.addEventListener("mouseup", onPointerUp);

window.addEventListener('contextmenu', function (e: MouseEvent) {
    if (!gameManager.board_initialised) return;
    if (e.button !== 2 || (<HTMLElement>e.target).tagName !== 'CANVAS') return;
    e.preventDefault();
    e.stopPropagation();
    gameManager.tools.getIndexValue(gameManager.selectedTool)!.onContextMenu(e);
});

$("#zoomer").slider({
    orientation: "vertical",
    min: 0.5,
    max: 5.0,
    step: 0.1,
    value: gameManager.layerManager.zoomFactor,
    slide: function (event, ui) {
        const origZ = gameManager.layerManager.zoomFactor;
        const newZ = 1 / ui.value!;
        const origX = window.innerWidth / origZ;
        const newX = window.innerWidth / newZ;
        const origY = window.innerHeight / origZ;
        const newY = window.innerHeight / newZ;
        gameManager.layerManager.zoomFactor = newZ;
        gameManager.layerManager.panX -= (origX - newX) / 2;
        gameManager.layerManager.panY -= (origY - newY) / 2;
        gameManager.layerManager.invalidate();
        socket.emit("set clientOptions", {
            zoomFactor: newZ,
            panX: gameManager.layerManager.panX,
            panY: gameManager.layerManager.panY
        });
    }
});

const $menu = $('#contextMenu');
$menu.hide();

const settings_menu = $("#menu")!;
const locations_menu = $("#locations-menu")!;
const layer_menu = $("#layerselect")!;
$("#selection-menu").hide();

$('#rm-settings').on("click", function () {
    // order of animation is important, it otherwise will sometimes show a small gap between the two objects
    if (settings_menu.is(":visible")) {
        $('#radialmenu').animate({ left: "-=200px" });
        settings_menu.animate({ width: 'toggle' });
        locations_menu.animate({ left: "-=200px", width: "+=200px" });
        layer_menu.animate({ left: "-=200px" });
    } else {
        settings_menu.animate({ width: 'toggle' });
        $('#radialmenu').animate({ left: "+=200px" });
        locations_menu.animate({ left: "+=200px", width: "-=200px" });
        layer_menu.animate({ left: "+=200px" });
    }
});

$('#rm-locations').on("click", function () {
    // order of animation is important, it otherwise will sometimes show a small gap between the two objects
    if (locations_menu.is(":visible")) {
        $('#radialmenu').animate({ top: "-=100px" });
        locations_menu.animate({ height: 'toggle' });
    } else {
        locations_menu.animate({ height: 'toggle' });
        $('#radialmenu').animate({ top: "+=100px" });
    }
});

window.onresize = function () {
    gameManager.layerManager.setWidth(window.innerWidth);
    gameManager.layerManager.setHeight(window.innerHeight);
    gameManager.layerManager.invalidate();
};

$('body').keyup(function (e) {
    if (e.keyCode === 46 && e.target.tagName !== "INPUT") {
        if (gameManager.layerManager.getLayer === undefined) {
            console.log("No active layer selected for delete operation");
            return;
        }
        const l = gameManager.layerManager.getLayer()!;
        l.selection.forEach(function (sel) {
            l.removeShape(sel, true, false);
            gameManager.initiativeTracker.removeInitiative(sel.uuid, true, false);
        });
    }
});

$("#gridSizeInput").on("change", function (e) {
    const gs = parseInt((<HTMLInputElement>e.target).value);
    gameManager.layerManager.setGridSize(gs);
    socket.emit("set gridsize", gs);
});

$("#unitSizeInput").on("change", function (e) {
    const us = parseInt((<HTMLInputElement>e.target).value);
    gameManager.layerManager.setUnitSize(us);
    socket.emit("set locationOptions", { 'unitSize': us });
});
$("#useGridInput").on("change", function (e) {
    const ug = (<HTMLInputElement>e.target).checked;
    gameManager.layerManager.setUseGrid(ug);
    socket.emit("set locationOptions", { 'useGrid': ug });
});
$("#useFOWInput").on("change", function (e) {
    const uf = (<HTMLInputElement>e.target).checked;
    gameManager.layerManager.setFullFOW(uf);
    socket.emit("set locationOptions", { 'fullFOW': uf });
});
$("#fowOpacity").on("change", function (e) {
    let fo = parseFloat((<HTMLInputElement>e.target).value);
    if (isNaN(fo)) {
        $("#fowOpacity").val(gameManager.layerManager.fowOpacity);
        return;
    }
    if (fo < 0) fo = 0;
    if (fo > 1) fo = 1;
    gameManager.layerManager.setFOWOpacity(fo);
    socket.emit("set locationOptions", { 'fowOpacity': fo });
});

export default gameManager;