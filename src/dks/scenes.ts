
import * as Viewer from "../viewer";

import * as BYML from "../byml";
import * as MSB from "./msb";
import * as DCX from "./dcx";
import * as TPF from "./tpf";
import * as BHD from "./bhd";
import * as BND3 from "./bnd3";
import * as FLVER from "./flver";

import { GfxDevice, GfxHostAccessPass } from "../gfx/platform/GfxPlatform";
import Progressable, { ProgressMeter } from "../Progressable";
import { fetchData, NamedArrayBufferSlice } from "../fetch";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { DDSTextureHolder } from "./dds";
import { assert } from "../util";
import { BasicRendererHelper } from "../oot3d/render";
import { FLVERData, MSBRenderer } from "./render";
import { Panel, LayerPanel } from "../ui";
import { SceneContext } from "../SceneBase";

interface CRG1Arc {
    Files: { [filename: string]: ArrayBufferSlice };
}

class DataFetcher {
    private fileProgressables: Progressable<any>[] = [];

    constructor(private abortSignal: AbortSignal, private progressMeter: ProgressMeter) {
    }

    private calcProgress(): number {
        let n = 0;
        for (let i = 0; i < this.fileProgressables.length; i++)
            n += this.fileProgressables[i].progress;
        return n / this.fileProgressables.length;
    }

    private setProgress(): void {
        this.progressMeter.setProgress(this.calcProgress());
    }

    public fetchData(path: string): PromiseLike<NamedArrayBufferSlice> {
        const p = fetchData(path, this.abortSignal);
        this.fileProgressables.push(p);
        p.onProgress = () => {
            this.setProgress();
        };
        this.setProgress();
        return p.promise;
    }
}

class ResourceSystem {
    public files = new Map<string, ArrayBufferSlice>();

    constructor() {
    }

    public mountCRG1(n: CRG1Arc): void {
        const filenames = Object.keys(n.Files);
        for (let i = 0; i < filenames.length; i++)
            this.files.set(filenames[i], n.Files[filenames[i]]);
    }

    public mountFile(fileName: string, buffer: ArrayBufferSlice): void {
        this.files.set(fileName, buffer);
    }

    public lookupFile(filename: string) {
        return this.files.get(filename);
    }
}

class DKSRenderer extends BasicRendererHelper implements Viewer.SceneGfx {
    private sceneRenderers: MSBRenderer[] = [];

    constructor(device: GfxDevice, public textureHolder: DDSTextureHolder, private modelHolder: ModelHolder) {
        super();
    }

    public createPanels(): Panel[] {
        const layerPanel = new LayerPanel(this.sceneRenderers[0].flverInstances);
        return [layerPanel];
    }

    public addSceneRenderer(device: GfxDevice, sceneRenderer: MSBRenderer): void {
        this.sceneRenderers.push(sceneRenderer);
        sceneRenderer.addToViewRenderer(device, this.viewRenderer);
    }

    public prepareToRender(hostAccessPass: GfxHostAccessPass, viewerInput: Viewer.ViewerRenderInput): void {
        for (let i = 0; i < this.sceneRenderers.length; i++)
            this.sceneRenderers[i].prepareToRender(hostAccessPass, viewerInput);
    }

    public destroy(device: GfxDevice): void {
        super.destroy(device);
        for (let i = 0; i < this.sceneRenderers.length; i++)
            this.sceneRenderers[i].destroy(device);
        this.textureHolder.destroy(device);
        this.modelHolder.destroy(device);
    }
}

export class ModelHolder {
    public flverData: (FLVERData | undefined)[] = [];

    constructor(device: GfxDevice, flver: (FLVER.FLVER | undefined)[]) {
        for (let i = 0; i < flver.length; i++)
            if (flver[i] !== undefined)
                this.flverData[i] = new FLVERData(device, flver[i]);
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.flverData.length; i++)
            if (this.flverData[i] !== undefined)
                this.flverData[i].destroy(device);
    }
}

const pathBase = `dks`;

async function fetchCRG1Arc(resourceSystem: ResourceSystem, dataFetcher: DataFetcher, archiveName: string) {
    const buffer = await dataFetcher.fetchData(`${pathBase}/${archiveName}`);
    const crg1Arc = BYML.parse<CRG1Arc>(buffer, BYML.FileType.CRG1);
    resourceSystem.mountCRG1(crg1Arc);
}

async function fetchLoose(resourceSystem: ResourceSystem, dataFetcher: DataFetcher, fileName: string) {
    const buffer = await dataFetcher.fetchData(`${pathBase}/${fileName}`);
    resourceSystem.mountFile(fileName, buffer);
}

export class DKSSceneDesc implements Viewer.SceneDesc {
    constructor(public id: string, public name: string) {
    }

    private loadTextureTPFDCX(device: GfxDevice, textureHolder: DDSTextureHolder, resourceSystem: ResourceSystem, baseName: string): void {
        const buffer = resourceSystem.lookupFile(`${baseName}.tpf.dcx`);
        const decompressed = new ArrayBufferSlice(DCX.decompressBuffer(buffer));
        const tpf = TPF.parse(decompressed);
        textureHolder.addTextures(device, tpf.textures);
    }

    private loadTextureBHD(device: GfxDevice, textureHolder: DDSTextureHolder, resourceSystem: ResourceSystem, baseName: string): void {
        const bhdBuffer = resourceSystem.lookupFile(`${baseName}.tpfbhd`);
        const bdtBuffer = resourceSystem.lookupFile(`${baseName}.tpfbdt`);
        const bhd = BHD.parse(bhdBuffer, bdtBuffer);
        for (let i = 0; i < bhd.fileRecords.length; i++) {
            const r = bhd.fileRecords[i];
            assert(r.name.endsWith('.tpf.dcx'));
            const decompressed = new ArrayBufferSlice(DCX.decompressBuffer(r.buffer));
            const tpf = TPF.parse(decompressed);
            assert(tpf.textures.length === 1);
            const key1 = r.name.replace(/\\/g, '').replace('.tpf.dcx', '').toLowerCase();
            const key2 = tpf.textures[0].name.toLowerCase();
            assert(key1 === key2);
            // WTF do we do if we have more than one texture?
            textureHolder.addTextures(device, tpf.textures);
        }
    }

    public async createScene(device: GfxDevice, abortSignal: AbortSignal, sceneContext: SceneContext): Promise<Viewer.SceneGfx> {
        const dataFetcher = new DataFetcher(sceneContext.abortSignal, sceneContext.progressMeter);
        const resourceSystem = new ResourceSystem();

        resourceSystem
        const arcName = `${this.id}_arc.crg1`;

        await Promise.all([
            fetchCRG1Arc(resourceSystem, dataFetcher, arcName),
            fetchLoose(resourceSystem, dataFetcher, `mtd/Mtd.mtdbnd`),
        ]);

        const textureHolder = new DDSTextureHolder();

        const msbPath = `/map/MapStudio/${this.id}.msb`;
        const msbBuffer = resourceSystem.lookupFile(msbPath);
        const msb = MSB.parse(msbBuffer, this.id);

        const mtdBnd = BND3.parse(resourceSystem.lookupFile(`mtd/Mtd.mtdbnd`));
        console.log(mtdBnd);

        const flver: (FLVER.FLVER | undefined)[] = [];
        for (let i = 0; i < msb.models.length; i++) {
            if (msb.models[i].type === 0) {
                const flverBuffer = resourceSystem.lookupFile(msb.models[i].flverPath);
                const flver_ = FLVER.parse(new ArrayBufferSlice(DCX.decompressBuffer(flverBuffer)));
                if (flver_.batches.length > 0)
                    flver[i] = flver_;
            }
        }

        const modelHolder = new ModelHolder(device, flver);

        const mapKey = this.id.slice(0, 3); // "m10"
        this.loadTextureBHD(device, textureHolder, resourceSystem, `/map/${mapKey}/${mapKey}_0000`);
        this.loadTextureBHD(device, textureHolder, resourceSystem, `/map/${mapKey}/${mapKey}_0001`);
        this.loadTextureBHD(device, textureHolder, resourceSystem, `/map/${mapKey}/${mapKey}_0002`);
        this.loadTextureBHD(device, textureHolder, resourceSystem, `/map/${mapKey}/${mapKey}_0003`);
        this.loadTextureTPFDCX(device, textureHolder, resourceSystem, `/map/${mapKey}/${mapKey}_9999`);

        const sceneRenderer = new MSBRenderer(device, textureHolder, modelHolder, msb);

        const renderer = new DKSRenderer(device, textureHolder, modelHolder);
        renderer.addSceneRenderer(device, sceneRenderer);
        return renderer;
    }
}

const id = 'dks';
const name = "Dark Souls";

const sceneDescs = [
    new DKSSceneDesc('m10_01_00_00', "Undead Burg / Parish"),
    new DKSSceneDesc('m10_00_00_00', "The Depths"),
    new DKSSceneDesc('m10_02_00_00', "Firelink Shrine"),
    new DKSSceneDesc('m11_00_00_00', "Painted World"),
    new DKSSceneDesc('m12_00_00_00', "Darkroot Forest"),
    new DKSSceneDesc('m12_00_00_01', "Darkroot Basin"),
    new DKSSceneDesc('m12_01_00_00', "Royal Wood"),
    new DKSSceneDesc('m13_00_00_00', "The Catacombs"),
    new DKSSceneDesc('m13_01_00_00', "Tomb of the Giants"),
    new DKSSceneDesc('m13_02_00_00', "Ash Lake"),
    new DKSSceneDesc('m14_00_00_00', "Blighttown"),
    new DKSSceneDesc('m14_01_00_00', "Demon Ruins"),
    new DKSSceneDesc('m15_00_00_00', "Sen's Fortress"),
    new DKSSceneDesc('m15_01_00_00', "Anor Londo"),
    new DKSSceneDesc('m16_00_00_00', "New Londo Ruins"),
    new DKSSceneDesc('m17_00_00_00', "Duke's Archives / Crystal Caves"),
    new DKSSceneDesc('m18_00_00_00', "Kiln of the First Flame"),
    new DKSSceneDesc('m18_01_00_00', "Undead Asylum"),
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs };
