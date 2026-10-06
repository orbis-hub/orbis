import accounts from "./accounts.json";
import common from "./common.json";
import dashboard from "./dashboard.json";
import devices from "./devices.json";
import eink from "./eink.json";
import kiosk from "./kiosk.json";
import login from "./login.json";
import modules from "./modules.json";
import notifications from "./notifications.json";
import settings from "./settings.json";
import shell from "./shell.json";

/** one flat bundle per language; keys are prefixed by area, e.g. "shell.nav.settings" */
const messages = { ...common, ...shell, ...login, ...settings, ...dashboard, ...modules, ...accounts, ...devices, ...eink, ...kiosk, ...notifications };
export default messages;
