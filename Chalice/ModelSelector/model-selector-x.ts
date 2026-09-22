import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";

import { installModelSelectorXPatches } from "./src/model-selector-x-component.js";

export default function modelSelectorXExtension(pi) {
	const unpatch = installModelSelectorXPatches(ModelSelectorComponent);

	pi.on("session_shutdown", unpatch);
}
