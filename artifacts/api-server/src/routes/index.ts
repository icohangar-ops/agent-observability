import { Router, type IRouter } from "express";
import healthRouter from "./health";
import observabilityRouter from "./observability";

const router: IRouter = Router();

router.use(healthRouter);
router.use(observabilityRouter);

export default router;
