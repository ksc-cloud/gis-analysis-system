package com.example.gis_analysis_system.history;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.AbstractPlatformTransactionManager;
import org.springframework.transaction.support.DefaultTransactionStatus;

/** Records begin/commit/rollback and applies them to the fake mapper; runs a check right before each commit. */
class RecordingTransactionManager extends AbstractPlatformTransactionManager {

	final List<String> events = new CopyOnWriteArrayList<>();

	private final FakeAnalysisHistoryMapper mapper;

	volatile Runnable beforeCommit = () -> {
	};

	RecordingTransactionManager(FakeAnalysisHistoryMapper mapper) {
		this.mapper = mapper;
	}

	@Override
	protected Object doGetTransaction() {
		return new Object();
	}

	@Override
	protected void doBegin(Object transaction, TransactionDefinition definition) {
		this.events.add(definition.isReadOnly() ? "begin-read" : "begin");
		if (!definition.isReadOnly()) {
			this.mapper.begin();
		}
	}

	@Override
	protected void doCommit(DefaultTransactionStatus status) {
		this.beforeCommit.run();
		this.events.add("commit");
		this.mapper.commit();
	}

	@Override
	protected void doRollback(DefaultTransactionStatus status) {
		this.events.add("rollback");
		this.mapper.rollback();
	}

}
