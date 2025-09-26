// Instruct orchestrator, trainer and user interaction with the system of ai's
// Using the gateway api to complete tasks we will dynamically create and assign tasks to the ai's
// We will use the brain to manage the state of the ai's and their tasks
// The brain will be responsible for creating, updating, and deleting tasks
// The brain will also be responsible for assigning tasks to the ai's
// The brain will use the gateway api to communicate with the ai's

import { log } from "./utils.js";
import { getConfig } from "./config/index.js";

const CFG = getConfig();

class Brain {
  constructor() {
    this.ais = [];
    this.goals = []; 
    this.tasks = []; 
    this.taskIdCounter = 1;
    this.CFG = CFG;
    this.contexts = {}; // Store context for each AI hotswapping
    this.models = {}; // Available models for AI instances
    this.promptBuilder(); // Initialize prompt builder
    }
