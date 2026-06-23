import { Router, type IRouter } from "express";
import healthRouter from "./health";
import observabilityRouter from "./observability";
import tracesRouter from "./traces";

const router: IRouter = Router();

router.use(healthRouter);
router.use(observabilityRouter);
router.use(tracesRouter);

export default router;
