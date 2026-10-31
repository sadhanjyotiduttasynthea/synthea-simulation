"""Gaussian-process surrogate models trained on recorded experiments.

Inputs are formulation mass fractions (and optionally process temperature);
outputs are a measured response (e.g. viscosity, shape retention). A GP with a
Matern(nu=2.5) kernel, per-feature length scales and a white-noise term is fit
by maximum marginal likelihood (scikit-learn). Leave-one-out cross-validation
is reported so the user can judge predictive quality; predictions always come
with a standard deviation.
"""
from __future__ import annotations

import warnings

import numpy as np
from sklearn.exceptions import ConvergenceWarning
from sklearn.gaussian_process import GaussianProcessRegressor
from sklearn.gaussian_process.kernels import ConstantKernel, Matern, WhiteKernel

RESPONSES = {
    "viscosity_pa_s": {"label": "Apparent viscosity", "unit": "Pa s", "log": True},
    "hardness_n": {"label": "Texture: hardness", "unit": "N", "log": False},
    "shape_retention_pct": {"label": "Shape retention", "unit": "%", "log": False},
}

MIN_POINTS = 6


def extract_xy(experiments: list[dict], ingredient_ids: list[str], response: str, include_temperature: bool = False):
    X, y, used = [], [], []
    for e in experiments:
        val = (e.get("measurements") or {}).get(response)
        if val is None:
            continue
        comp = e.get("composition") or {}
        row = [float(comp.get(i, 0.0)) for i in ingredient_ids]
        if include_temperature:
            row.append(float((e.get("process") or {}).get("temperature_c") or 25.0))
        X.append(row)
        y.append(float(val))
        used.append(e)
    return np.array(X, dtype=float), np.array(y, dtype=float), used


class Surrogate:
    def __init__(self, ingredient_ids, response, include_temperature=False):
        self.ingredient_ids = list(ingredient_ids)
        self.response = response
        self.log = RESPONSES.get(response, {}).get("log", False)
        self.include_temperature = include_temperature
        self.gp = None
        self.X = None
        self.y = None
        self.data_types = []

    def _ty(self, y):
        return np.log(y) if self.log else y

    def fit(self, experiments: list[dict]):
        X, y, used = extract_xy(experiments, self.ingredient_ids, self.response, self.include_temperature)
        if len(y) < MIN_POINTS:
            raise ValueError(f"Only {len(y)} experiments with '{self.response}' recorded; at least {MIN_POINTS} are required to train a surrogate model.")
        if self.log and np.any(y <= 0):
            raise ValueError("Log-transformed response requires positive values.")
        self.X, self.y = X, y
        self.data_types = sorted({u.get("data_type", "measured") for u in used})
        self.mu_x = X.mean(axis=0)
        self.sd_x = X.std(axis=0)
        self.sd_x[self.sd_x < 1e-9] = 1.0
        self.gp = self._make_gp()
        Xs = (X - self.mu_x) / self.sd_x
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", ConvergenceWarning)
            self.gp.fit(Xs, self._ty(y))
        return self

    def _make_gp(self):
        d = self.X.shape[1]
        kernel = ConstantKernel(1.0, (1e-3, 1e3)) * Matern(length_scale=np.ones(d), length_scale_bounds=(1e-2, 1e3), nu=2.5) + WhiteKernel(1e-2, (1e-6, 1e1))
        return GaussianProcessRegressor(kernel=kernel, normalize_y=True, n_restarts_optimizer=3, random_state=0)

    def predict(self, X):
        X = np.atleast_2d(np.asarray(X, dtype=float))
        Xs = (X - self.mu_x) / self.sd_x
        m, s = self.gp.predict(Xs, return_std=True)
        if self.log:
            # log-normal: report median and approximate 1-sigma multiplicative band
            return np.exp(m), s, np.exp(m - s), np.exp(m + s)
        return m, s, m - s, m + s

    def predict_transformed(self, X):
        X = np.atleast_2d(np.asarray(X, dtype=float))
        return self.gp.predict((X - self.mu_x) / self.sd_x, return_std=True)

    def loo_cv(self) -> dict:
        """Leave-one-out CV with kernel hyper-parameters fixed at the full-data optimum."""
        n = len(self.y)
        preds = np.zeros(n)
        ty = self._ty(self.y)
        Xs = (self.X - self.mu_x) / self.sd_x
        for i in range(n):
            mask = np.arange(n) != i
            gp = GaussianProcessRegressor(kernel=self.gp.kernel_, normalize_y=True, optimizer=None)
            gp.fit(Xs[mask], ty[mask])
            preds[i] = gp.predict(Xs[i:i + 1])[0]
        resid = ty - preds
        ss_res = float(np.sum(resid ** 2))
        ss_tot = float(np.sum((ty - ty.mean()) ** 2)) or 1e-12
        return {
            "n": n,
            "rmse_transformed": float(np.sqrt(np.mean(resid ** 2))),
            "q2": 1.0 - ss_res / ss_tot,
            "space": "log" if self.log else "linear",
            "predictions": [float(np.exp(p) if self.log else p) for p in preds],
            "observed": [float(v) for v in self.y],
        }

    def novelty(self, X) -> np.ndarray:
        """Distance to nearest training point in standardised space (extrapolation indicator)."""
        X = np.atleast_2d(np.asarray(X, dtype=float))
        Xs = (X - self.mu_x) / self.sd_x
        Ts = (self.X - self.mu_x) / self.sd_x
        d = np.sqrt(((Xs[:, None, :] - Ts[None, :, :]) ** 2).sum(-1))
        return d.min(axis=1)

    def info(self) -> dict:
        return {
            "response": self.response,
            "response_label": RESPONSES.get(self.response, {}).get("label", self.response),
            "unit": RESPONSES.get(self.response, {}).get("unit", ""),
            "n_training": int(len(self.y)),
            "kernel": str(self.gp.kernel_),
            "log_transformed": self.log,
            "data_types": self.data_types,
            "features": self.ingredient_ids + (["temperature_c"] if self.include_temperature else []),
        }
